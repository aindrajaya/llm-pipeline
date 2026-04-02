"""
theme_aggregator.py — Deceptive theme aggregation across batch items.

Input: list of AnalysisResult records from completed batch items.
Output: ThemeReport with ≤50 themes, sorted by confidence DESC, frequency DESC.

Each theme includes: theme_id, theme_title, description, confidence,
frequency, supporting_items, example_snippets (≤3).
"""
import json
import uuid
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from .vllm_server import generate

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_THEMES = 50


# ─── Request / Response models ────────────────────────────────────────────────

class ReportItem(BaseModel):
    id: str
    batch_item_id: str
    summary: Optional[str] = None
    deception_indicators: Optional[list] = []
    confidence_score: Optional[float] = 0.0


class ThemeAggregationRequest(BaseModel):
    batch_id: str
    reports: list[ReportItem]


class Theme(BaseModel):
    theme_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    theme_title: str = Field(..., max_length=100)
    description: str
    confidence: float = Field(..., ge=0.0, le=1.0)
    frequency: int = Field(..., ge=1)
    supporting_items: list[str] = []
    example_snippets: list[str] = Field(default=[], max_length=3)


class ThemeReport(BaseModel):
    batch_id: str
    model_name: str = "mistral-small-3.2"
    theme_count: int
    themes: list[Theme]


THEME_AGGREGATION_SYSTEM_PROMPT = """You are an expert deception analysis AI specializing in identifying cross-document thematic patterns.

You will receive a list of individual deception analysis reports. Your task is to:
1. Identify recurring themes, language patterns, and common deception indicators across all reports.
2. Cluster related signals into named themes.
3. Return a JSON object with EXACTLY this structure:

{
  "themes": [
    {
      "theme_title": "<concise title, max 100 chars>",
      "description": "<detailed description of this deception theme>",
      "confidence": <float 0.0-1.0, based on consistency across items>,
      "frequency": <int, number of items where this theme appears>,
      "supporting_items": ["batch_item_id_1", "batch_item_id_2"],
      "example_snippets": ["<verbatim excerpt 1>", "<verbatim excerpt 2>"]
    }
  ]
}

Rules:
- Maximum 50 themes. Merge similar themes rather than outputting duplicates.
- Sort by confidence DESC, then frequency DESC.
- Only include themes with frequency >= 2 (appears in at least 2 items).
- Each theme must have at most 3 example_snippets.
- Output ONLY the JSON object. No markdown, no preamble."""


def _build_aggregation_prompt(reports: list[ReportItem]) -> str:
    # Summarize reports for aggregation (avoid exceeding context window)
    report_summaries = []
    for r in reports:
        indicators = r.deception_indicators or []
        report_summaries.append({
            "item_id": r.batch_item_id,
            "summary": (r.summary or "")[:500],
            "confidence": r.confidence_score,
            "indicators": [
                {"indicator": ind.get("indicator", ""), "excerpt": ind.get("excerpt", "")[:200]}
                for ind in indicators[:10]  # Cap indicators per item
            ],
        })

    # Truncate at 80 reports if too many (context limit)
    if len(report_summaries) > 80:
        report_summaries = report_summaries[:80]

    reports_json = json.dumps(report_summaries, indent=2)
    return f"[INST] {THEME_AGGREGATION_SYSTEM_PROMPT}\n\nAnalysis reports:\n{reports_json} [/INST]"


def _parse_theme_report(raw: str, request: ThemeAggregationRequest) -> ThemeReport:
    try:
        start = raw.find('{')
        end = raw.rfind('}') + 1
        if start == -1 or end == 0:
            raise ValueError("No JSON object found")
        parsed = json.loads(raw[start:end])
        themes_raw = parsed.get("themes", [])

        themes = []
        for t in themes_raw[:MAX_THEMES]:
            try:
                snippets = t.get("example_snippets", [])[:3]
                themes.append(Theme(
                    theme_title=str(t.get("theme_title", "Unnamed Theme"))[:100],
                    description=t.get("description", ""),
                    confidence=float(t.get("confidence", 0.0)),
                    frequency=int(t.get("frequency", 1)),
                    supporting_items=t.get("supporting_items", []),
                    example_snippets=snippets,
                ))
            except Exception as e:
                logger.warning(f"Skipping malformed theme: {e}")

        # Sort: confidence DESC, frequency DESC
        themes.sort(key=lambda t: (-t.confidence, -t.frequency))

        return ThemeReport(
            batch_id=request.batch_id,
            theme_count=len(themes),
            themes=themes,
        )
    except Exception as e:
        logger.error(f"Failed to parse theme aggregation output: {e}\nRaw: {raw[:500]}")
        return ThemeReport(
            batch_id=request.batch_id,
            theme_count=0,
            themes=[],
        )


@router.post("/themes/aggregate", response_model=ThemeReport)
async def aggregate_themes(req: ThemeAggregationRequest):
    """
    Aggregate deception themes across all completed batch items.
    Returns ThemeReport with ≤50 themes.
    Background job — not blocking the web response.
    """
    if not req.reports:
        raise HTTPException(status_code=422, detail="No reports provided for aggregation")

    if len(req.reports) < 2:
        logger.info(f"Batch {req.batch_id}: only 1 report — skipping theme aggregation")
        return ThemeReport(batch_id=req.batch_id, theme_count=0, themes=[])

    logger.info(f"Aggregating themes for batch {req.batch_id} across {len(req.reports)} reports")

    prompt = _build_aggregation_prompt(req.reports)
    [raw_output] = generate([prompt], temperature=0.1, max_tokens=4096)

    report = _parse_theme_report(raw_output, req)
    logger.info(f"Theme aggregation complete: {report.theme_count} themes for batch {req.batch_id}")
    return report
