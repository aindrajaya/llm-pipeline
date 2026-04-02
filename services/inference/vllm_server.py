"""
vllm_server.py — vLLM LLM singleton for Mistral Small 3.2.

This module manages the model lifecycle: a single LLM instance is loaded
once at startup and shared across all inference requests.

GPU configuration:
  - AWQ 4-bit quantization (reduces VRAM ~75% vs FP16)
  - gpu_memory_utilization=0.85 (15% headroom for KV cache growth)
  - max_num_seqs=100 (matches 100-item batch capacity)
  - enforce_eager=False (enables CUDA graph capture for kernel fusion)
"""
import os
import logging
from contextlib import asynccontextmanager

logger = logging.getLogger(__name__)

# ─── Configuration (all overridable via env) ──────────────────────────────────
MODEL_ID = os.environ.get("MISTRAL_MODEL_ID", "mistralai/Mistral-Small-3.2")
QUANTIZATION = os.environ.get("QUANTIZATION", "awq")  # awq | gptq | None
GPU_MEMORY_UTILIZATION = float(os.environ.get("GPU_MEMORY_UTILIZATION", "0.85"))
MAX_NUM_SEQS = int(os.environ.get("MAX_NUM_SEQS", "100"))
MAX_MODEL_LEN = int(os.environ.get("MAX_MODEL_LEN", "8192"))
TENSOR_PARALLEL_SIZE = int(os.environ.get("TENSOR_PARALLEL_SIZE", "1"))
CPU_FALLBACK = os.environ.get("CPU_FALLBACK", "false").lower() == "true"

_llm = None


def get_llm():
    """Return the global LLM instance (must be initialized first)."""
    if _llm is None:
        raise RuntimeError("LLM not initialized. Call init_llm() first.")
    return _llm


def init_llm():
    """
    Initialize the vLLM LLM singleton.
    Called once at application startup.
    """
    global _llm

    if CPU_FALLBACK:
        logger.warning("CPU_FALLBACK=true — using stub LLM (no GPU inference)")
        _llm = _StubLLM()
        return

    try:
        from vllm import LLM, SamplingParams  # noqa: F401
        logger.info(
            f"Loading {MODEL_ID} with quantization={QUANTIZATION}, "
            f"gpu_memory_utilization={GPU_MEMORY_UTILIZATION}, max_num_seqs={MAX_NUM_SEQS}"
        )
        _llm = LLM(
            model=MODEL_ID,
            quantization=QUANTIZATION if QUANTIZATION != "none" else None,
            gpu_memory_utilization=GPU_MEMORY_UTILIZATION,
            max_num_seqs=MAX_NUM_SEQS,
            max_model_len=MAX_MODEL_LEN,
            tensor_parallel_size=TENSOR_PARALLEL_SIZE,
            enforce_eager=False,  # Allow CUDA graph capture for kernel fusion
        )
        logger.info("vLLM model loaded successfully")
    except ImportError:
        logger.warning("vLLM not available — falling back to stub LLM")
        _llm = _StubLLM()
    except Exception as e:
        logger.error(f"Failed to load vLLM model: {e}")
        raise


def generate(prompts: list[str], temperature: float = 0.0, max_tokens: int = 2048) -> list[str]:
    """
    Run batch inference. Returns list of generated text strings.
    Temperature=0.0 for deterministic deception analysis.
    """
    from vllm import SamplingParams

    llm = get_llm()
    if isinstance(llm, _StubLLM):
        return llm.generate(prompts)

    sampling_params = SamplingParams(
        temperature=temperature,
        max_tokens=max_tokens,
        stop=["</s>", "[INST]"],
    )
    outputs = llm.generate(prompts, sampling_params)
    return [out.outputs[0].text for out in outputs]


async def generate_stream(prompt: str, temperature: float = 0.0, max_tokens: int = 2048):
    """
    Async generator yielding token chunks for streaming inference.
    Used for SSE responses to the frontend.
    """
    llm = get_llm()
    if isinstance(llm, _StubLLM):
        # Stub: yield entire response at once
        for word in llm.generate([prompt])[0].split():
            yield word + " "
        return

    from vllm import SamplingParams

    sampling_params = SamplingParams(temperature=temperature, max_tokens=max_tokens)
    async for output in llm.generate_async(prompt, sampling_params):
        if output.outputs:
            yield output.outputs[0].text


# ─── Stub LLM for CPU-only dev environments ──────────────────────────────────
class _StubLLM:
    """CPU-mode stub — returns placeholder analysis for local dev without GPU."""

    def generate(self, prompts: list[str]) -> list[str]:
        return [
            '{"summary": "Stub analysis — GPU not available.", '
            '"deception_indicators": [], "confidence_score": 0.0, '
            '"raw_output": {"mode": "cpu_stub"}}'
            for _ in prompts
        ]
