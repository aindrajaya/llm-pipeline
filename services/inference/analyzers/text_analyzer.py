"""
text_analyzer.py — Text deception analysis endpoint.

Pipeline: raw text → (client model preprocessing) → Mistral Small 3.2 inference
→ structured AnalysisResult output.

Client model adapter:
  The TEXT_MODEL_PATH env var should point to the client's HuggingFace repo
  or local weights directory. The adapter interface is defined here; swap in
  the real implementation by replacing _ClientTextModelAdapter._analyze().
"""
import json
import os
import logging
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import Optional
from ..vllm_server import generate, generate_stream

logger = logging.getLogger(__name__)
router = APIRouter()

TEXT_MODEL_PATH = os.environ.get("TEXT_MODEL_PATH", "")


# ─── Output contract (Pydantic schema) ───────────────────────────────────────

class DeceptionIndicator(BaseModel):
    indicator: str = Field(..., description="Name of the deception indicator")
    severity: str = Field(..., description="low | medium | high")
    excerpt: str = Field(..., description="Verbatim text excerpt supporting this indicator")


class AnalysisResult(BaseModel):
    item_id: str
    model_name: str
    model_version: str
    summary: str
    deception_indicators: list[DeceptionIndicator] = []
    confidence_score: float = Field(..., ge=0.0, le=1.0)
    raw_output: dict = {}


# ─── Request models ──────────────────────────────────────────────────────────

class TextAnalysisRequest(BaseModel):
    item_id: str
    text: Optional[str] = None
    file_url: Optional[str] = None  # Path to text/document file


class StreamAnalysisRequest(BaseModel):
    item_id: str
    text: str


# ─── Client model adapter (stub — replace with real impl) ───────────────────

class _ClientTextModelAdapter:
    """
    Adapter for the client-supplied text analysis model.
    Replace _analyze() with actual model inference using TEXT_MODEL_PATH.
    """
    def __init__(self):
        self.model_path = TEXT_MODEL_PATH
        if self.model_path:
            logger.info(f"Client text model configured: {self.model_path}")
        else:
            logger.warning("TEXT_MODEL_PATH not set — using passthrough adapter")

    def preprocess(self, text: str) -> str:
        """Clean and normalize text for inference."""
        return text.strip()

    def _analyze(self, text: str) -> dict:
        """
        Client model inference stub.
        Returns: dict with keys consumed by _build_prompt().
        Replace this with actual model call.
        """
        if not self.model_path:
            return {"preprocessed_text": text, "client_features": {}}
        # TODO: Load and run client model
        # from transformers import pipeline
        # pipe = pipeline("text-classification", model=self.model_path)
        # result = pipe(text)
        # return {"preprocessed_text": text, "client_features": result}
        return {"preprocessed_text": text, "client_features": {}}


_client_adapter = _ClientTextModelAdapter()

DECEPTION_SYSTEM_PROMPT = """You are an expert deception analysis AI. Analyze the provided text for indicators of deception, manipulation, or dishonesty.

Your output MUST be valid JSON with the following structure:
{
  "summary": "<brief summary of findings>",
  "deception_indicators": [
    {"indicator": "<indicator name>", "severity": "low|medium|high", "excerpt": "<verbatim quote>"}
  ],
  "confidence_score": <float 0.0-1.0>
}

Be specific. Only flag genuine deception signals. Output ONLY the JSON object, no other text."""


def _build_prompt(text: str, client_features: dict) -> str:
    features_note = ""
    if client_features:
        features_note = f"\n\nClient model pre-analysis features: {json.dumps(client_features)}"
    return f"[INST] {DECEPTION_SYSTEM_PROMPT}\n\nText to analyze:{features_note}\n\n{text[:4000]} [/INST]"


def _parse_llm_output(raw: str, item_id: str) -> AnalysisResult:
    try:
        # Extract JSON from response
        start = raw.find('{')
        end = raw.rfind('}') + 1
        if start == -1 or end == 0:
            raise ValueError("No JSON found in response")
        parsed = json.loads(raw[start:end])
        return AnalysisResult(
            item_id=item_id,
            model_name="mistral-small-3.2",
            model_version="1.0.0",
            summary=parsed.get("summary", ""),
            deception_indicators=[
                DeceptionIndicator(**ind) for ind in parsed.get("deception_indicators", [])
            ],
            confidence_score=float(parsed.get("confidence_score", 0.0)),
            raw_output={"raw_text": raw},
        )
    except Exception as e:
        logger.warning(f"Failed to parse LLM output for item {item_id}: {e}")
        return AnalysisResult(
            item_id=item_id,
            model_name="mistral-small-3.2",
            model_version="1.0.0",
            summary="Parse error — raw output preserved",
            deception_indicators=[],
            confidence_score=0.0,
            raw_output={"parse_error": str(e), "raw_text": raw},
        )


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/analyze/text", response_model=AnalysisResult)
async def analyze_text(req: TextAnalysisRequest):
    """Analyze a single text item for deception indicators."""
    text = req.text

    if not text and req.file_url:
        try:
            import aiofiles
            async with aiofiles.open(req.file_url, mode='r', encoding='utf-8', errors='replace') as f:
                text = await f.read()
        except Exception as e:
            raise HTTPException(status_code=422, detail=f"Failed to read file: {e}")

    if not text:
        raise HTTPException(status_code=422, detail="Either 'text' or 'file_url' must be provided")

    # Client model preprocessing
    client_result = _client_adapter._analyze(_client_adapter.preprocess(text))
    prompt = _build_prompt(text, client_result.get("client_features", {}))

    [raw_output] = generate([prompt])
    return _parse_llm_output(raw_output, req.item_id)


@router.post("/analyze/stream")
async def analyze_text_stream(req: StreamAnalysisRequest):
    """Stream text analysis output via SSE for real-time frontend display."""
    client_result = _client_adapter._analyze(_client_adapter.preprocess(req.text))
    prompt = _build_prompt(req.text, client_result.get("client_features", {}))

    async def event_stream():
        async for token in generate_stream(prompt):
            yield f"data: {json.dumps({'token': token})}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
