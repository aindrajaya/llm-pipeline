"""
main.py — FastAPI application for the inference service.

Startup: initializes vLLM model singleton.
Mounts: text analyzer, audio analyzer, theme aggregator routers.
Exposes: /health, /metrics (Prometheus), /report-usage.
"""
import os
import logging
import time
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import (
    Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
)
from fastapi.responses import Response
from pydantic import BaseModel
from .vllm_server import init_llm

# Configure logging
logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)

# ─── Prometheus metrics ───────────────────────────────────────────────────────
inference_requests = Counter(
    "inference_requests_total",
    "Total inference requests",
    ["endpoint", "status"]
)
inference_latency = Histogram(
    "inference_latency_seconds",
    "Inference latency",
    ["endpoint"],
    buckets=[0.5, 1.0, 2.5, 5.0, 10.0, 20.0, 30.0, 60.0]
)
gpu_utilization = Gauge("gpu_sm_utilization_percent", "GPU SM utilization %")
active_sequences = Gauge("active_inference_sequences", "Currently active inference sequences")


# ─── Stripe usage reporting (called by Node.js worker via HTTP) ───────────────
class UsageReportRequest(BaseModel):
    subscription_item_id: str
    item_count: int
    batch_id: str


# ─── Application lifespan ────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Inference service starting — loading model...")
    init_llm()
    logger.info("Model loaded. Service ready.")
    yield
    logger.info("Inference service shutting down.")


# ─── FastAPI app ──────────────────────────────────────────────────────────────
app = FastAPI(
    title="Deception Analysis Inference Service",
    version="2.0.0",
    description="vLLM-backed inference for text and audio deception analysis",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Register routers ─────────────────────────────────────────────────────────
from .analyzers.text_analyzer import router as text_router
from .analyzers.audio_analyzer import router as audio_router
from .theme_aggregator import router as theme_router

app.include_router(text_router, tags=["Analysis"])
app.include_router(audio_router, tags=["Analysis"])
app.include_router(theme_router, tags=["Themes"])


# ─── Health endpoint ──────────────────────────────────────────────────────────
@app.get("/health", tags=["System"])
async def health():
    """Health check with GPU status."""
    gpu_info = {}
    try:
        import torch
        if torch.cuda.is_available():
            gpu_info = {
                "cuda_available": True,
                "device_name": torch.cuda.get_device_name(0),
                "memory_allocated_gb": round(torch.cuda.memory_allocated(0) / 1e9, 2),
                "memory_reserved_gb": round(torch.cuda.memory_reserved(0) / 1e9, 2),
            }
        else:
            gpu_info = {"cuda_available": False, "mode": "CPU fallback"}
    except ImportError:
        gpu_info = {"cuda_available": False, "mode": "torch not installed"}

    return {
        "status": "ok",
        "model": os.environ.get("MISTRAL_MODEL_ID", "not configured"),
        "timestamp": time.time(),
        "gpu": gpu_info,
    }


# ─── Prometheus metrics endpoint ──────────────────────────────────────────────
@app.get("/metrics", tags=["System"])
async def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ─── Stripe usage reporting (called by Node.js orchestrator) ─────────────────
@app.post("/report-usage", tags=["Billing"])
async def report_usage(req: UsageReportRequest):
    """Report batch usage to Stripe (called by Node.js theme-agg worker)."""
    import stripe
    stripe.api_key = os.environ.get("STRIPE_SECRET_KEY")
    if not stripe.api_key:
        raise HTTPException(status_code=503, detail="Stripe not configured")
    try:
        usage_record = stripe.SubscriptionItem.create_usage_record(
            req.subscription_item_id,
            quantity=req.item_count,
            timestamp="now",
            action="increment",
            idempotency_key=f"batch-usage-{req.batch_id}",
        )
        return {"status": "reported", "usage_record_id": usage_record.id}
    except stripe.error.StripeError as e:
        logger.error(f"Stripe usage report failed for batch {req.batch_id}: {e}")
        raise HTTPException(status_code=502, detail=f"Stripe error: {e.user_message}")


# ─── Dev entry point ─────────────────────────────────────────────────────────
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "services.inference.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        workers=int(os.environ.get("WORKERS", 1)),
        log_level="info",
    )
