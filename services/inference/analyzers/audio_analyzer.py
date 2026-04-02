"""
audio_analyzer.py — Audio deception analysis endpoint.

Pipeline: audio file → preprocessing → transcription (client model) →
deception inference (Mistral Small 3.2) → AnalysisResult

The audio pipeline reuses the same batch queue and job orchestration
as the text pipeline (no separate retry or monitoring).

Output schema matches text analysis AnalysisResult for contract parity.
"""
import os
import json
import logging
import tempfile
from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from .text_analyzer import AnalysisResult, _parse_llm_output, DECEPTION_SYSTEM_PROMPT
from ..vllm_server import generate

logger = logging.getLogger(__name__)
router = APIRouter()

AUDIO_MODEL_PATH = os.environ.get("AUDIO_MODEL_PATH", "")
SUPPORTED_AUDIO_FORMATS = {'.mp3', '.wav', '.ogg', '.m4a', '.webm', '.flac'}


# ─── Request model ────────────────────────────────────────────────────────────

class AudioAnalysisRequest(BaseModel):
    item_id: str
    file_url: str       # Path to audio file on disk
    language: Optional[str] = "en"


# ─── Client audio model adapter ──────────────────────────────────────────────

class _ClientAudioModelAdapter:
    """
    Adapter for the client-supplied audio analysis / transcription model.
    Replace transcribe() with actual model inference using AUDIO_MODEL_PATH.
    """
    def __init__(self):
        self.model_path = AUDIO_MODEL_PATH
        if self.model_path:
            logger.info(f"Client audio model configured: {self.model_path}")
        else:
            logger.warning("AUDIO_MODEL_PATH not set — using Whisper-tiny fallback")

    def transcribe(self, audio_path: str, language: str = "en") -> dict:
        """
        Transcribe audio file. Returns dict with 'text' key.
        Swap in client model implementation here.

        Fallback: uses openai-whisper tiny model for dev environments.
        """
        if self.model_path:
            # TODO: Load and run client audio model
            # Example pattern:
            # from transformers import pipeline
            # pipe = pipeline("automatic-speech-recognition", model=self.model_path)
            # result = pipe(audio_path)
            # return {"text": result["text"], "segments": result.get("chunks", [])}
            pass

        # Fallback: attempt to use whisper if available
        try:
            import whisper
            model = whisper.load_model("tiny")
            result = model.transcribe(audio_path, language=language)
            return {
                "text": result["text"],
                "segments": result.get("segments", []),
                "model": "whisper-tiny-fallback",
            }
        except ImportError:
            logger.warning("whisper not installed — returning stub transcription")
            return {
                "text": "[Audio transcription unavailable — install openai-whisper or set AUDIO_MODEL_PATH]",
                "segments": [],
                "model": "stub",
            }

    def extract_features(self, audio_path: str) -> dict:
        """
        Extract acoustic features (pitch, energy, speaking rate).
        These can be passed as context to the deception LLM prompt.
        """
        try:
            import librosa
            import numpy as np
            y, sr = librosa.load(audio_path, sr=None, mono=True)
            duration = librosa.get_duration(y=y, sr=sr)
            tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
            return {
                "duration_seconds": round(duration, 2),
                "estimated_tempo_bpm": round(float(tempo), 1),
                "rms_energy": round(float(np.sqrt(np.mean(y**2))), 4),
            }
        except Exception as e:
            logger.debug(f"Feature extraction skipped: {e}")
            return {}


_audio_adapter = _ClientAudioModelAdapter()

AUDIO_DECEPTION_SYSTEM_PROMPT = DECEPTION_SYSTEM_PROMPT + """

Additionally, you have access to acoustic feature data from the audio. Consider these signals
alongside the transcript content in your analysis."""


def _build_audio_prompt(transcript: str, features: dict) -> str:
    features_str = ""
    if features:
        features_str = f"\n\nAcoustic features: {json.dumps(features)}"
    return (
        f"[INST] {AUDIO_DECEPTION_SYSTEM_PROMPT}\n\n"
        f"Transcript:{features_str}\n\n{transcript[:4000]} [/INST]"
    )


# ─── Endpoint ─────────────────────────────────────────────────────────────────

@router.post("/analyze/audio", response_model=AnalysisResult)
async def analyze_audio(req: AudioAnalysisRequest):
    """
    Analyze an audio file for deception indicators.
    Pipeline: ingest → preprocess → transcribe → deception inference.
    """
    audio_path = req.file_url
    if not Path(audio_path).exists():
        raise HTTPException(status_code=422, detail=f"Audio file not found: {audio_path}")

    suffix = Path(audio_path).suffix.lower()
    if suffix not in SUPPORTED_AUDIO_FORMATS:
        raise HTTPException(
            status_code=422,
            detail=f"Unsupported audio format: {suffix}. Supported: {SUPPORTED_AUDIO_FORMATS}"
        )

    # Step 1: Transcribe using client model (or fallback)
    logger.info(f"Transcribing audio item {req.item_id}: {audio_path}")
    transcription = _audio_adapter.transcribe(audio_path, language=req.language)
    transcript_text = transcription.get("text", "")

    if not transcript_text.strip():
        raise HTTPException(status_code=422, detail="Transcription produced no text output")

    # Step 2: Extract acoustic features
    features = _audio_adapter.extract_features(audio_path)

    # Step 3: Deception inference via Mistral Small 3.2
    prompt = _build_audio_prompt(transcript_text, features)
    [raw_output] = generate([prompt])

    result = _parse_llm_output(raw_output, req.item_id)
    # Override model_name to indicate audio pipeline
    result.model_name = "mistral-small-3.2-audio"
    result.raw_output = {
        **result.raw_output,
        "transcript": transcript_text,
        "transcription_model": transcription.get("model", "unknown"),
        "acoustic_features": features,
    }
    return result
