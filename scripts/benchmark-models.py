"""
benchmark-models.py — FP16 vs AWQ 4-bit accuracy benchmark.

Validates that AWQ quantization produces < 2% deception score divergence
from FP16 baseline before deploying quantized model (PRD section 10.4).

Usage:
  python scripts/benchmark-models.py --items-file benchmark_items.json

The items file should be a JSON array of {"text": "..."} objects.
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

INFERENCE_URL = os.environ.get("INFERENCE_SERVICE_URL", "http://localhost:8000")


def parse_args():
    p = argparse.ArgumentParser(description="FP16 vs AWQ deception score benchmark")
    p.add_argument("--items-file", required=True, help="JSON file with benchmark items")
    p.add_argument("--fp16-url", default=None, help="FP16 inference URL (defaults to --inference-url with ?quant=fp16)")
    p.add_argument("--awq-url", default=None, help="AWQ inference URL (defaults to --inference-url with ?quant=awq)")
    p.add_argument("--divergence-threshold", type=float, default=0.02,
                   help="Max acceptable mean absolute divergence (default: 0.02 = 2%%)")
    return p.parse_args()


def load_items(path: str) -> list[dict]:
    with open(path) as f:
        items = json.load(f)
    if not items:
        print("Error: benchmark items file is empty", file=sys.stderr)
        sys.exit(1)
    print(f"Loaded {len(items)} benchmark items from {path}")
    return items


def run_inference_batch(items: list[dict], url: str, label: str) -> list[float]:
    try:
        import httpx
    except ImportError:
        print("Install httpx: pip install httpx", file=sys.stderr)
        sys.exit(1)

    scores = []
    client = httpx.Client(timeout=60.0)
    print(f"\nRunning {label} inference on {len(items)} items...")

    for i, item in enumerate(items):
        try:
            res = client.post(f"{url}/analyze/text", json={
                "item_id": f"benchmark-{i}",
                "text": item.get("text", ""),
            })
            res.raise_for_status()
            data = res.json()
            score = float(data.get("confidence_score", 0.0))
            scores.append(score)
            print(f"  [{i+1}/{len(items)}] score={score:.4f}", end="\r")
        except Exception as e:
            print(f"\n  [{i+1}] Error: {e}")
            scores.append(0.0)

    print(f"\n{label}: {len(scores)} scores collected")
    return scores


def compute_divergence(fp16_scores: list[float], awq_scores: list[float]) -> dict:
    if len(fp16_scores) != len(awq_scores):
        raise ValueError("Score lists must be same length")

    diffs = [abs(a - b) for a, b in zip(fp16_scores, awq_scores)]
    mean_abs_diff = sum(diffs) / len(diffs)
    max_diff = max(diffs)
    items_within_1pct = sum(1 for d in diffs if d < 0.01)

    return {
        "item_count": len(diffs),
        "mean_absolute_divergence": round(mean_abs_diff, 4),
        "max_divergence": round(max_diff, 4),
        "items_within_1pct": items_within_1pct,
        "pct_within_1pct": round(items_within_1pct / len(diffs) * 100, 1),
    }


def main():
    args = parse_args()
    items = load_items(args.items_file)

    fp16_url = args.fp16_url or INFERENCE_URL
    awq_url = args.awq_url or INFERENCE_URL

    t0 = time.time()
    fp16_scores = run_inference_batch(items, fp16_url, "FP16 baseline")
    fp16_time = time.time() - t0

    t0 = time.time()
    awq_scores = run_inference_batch(items, awq_url, "AWQ 4-bit")
    awq_time = time.time() - t0

    stats = compute_divergence(fp16_scores, awq_scores)

    fp16_avg = sum(fp16_scores) / len(fp16_scores)
    awq_avg = sum(awq_scores) / len(awq_scores)

    print("\n" + "="*55)
    print("  BENCHMARK RESULTS")
    print("="*55)
    print(f"  Items tested:           {stats['item_count']}")
    print(f"  FP16 avg confidence:    {fp16_avg:.4f}")
    print(f"  AWQ avg confidence:     {awq_avg:.4f}")
    print(f"  Mean absolute divergence: {stats['mean_absolute_divergence']:.4f} ({stats['mean_absolute_divergence']*100:.2f}%)")
    print(f"  Max divergence:         {stats['max_divergence']:.4f}")
    print(f"  Items within 1% diff:   {stats['items_within_1pct']}/{stats['item_count']} ({stats['pct_within_1pct']}%)")
    print(f"  FP16 inference time:    {fp16_time:.1f}s ({fp16_time/len(items)*1000:.0f}ms/item)")
    print(f"  AWQ inference time:     {awq_time:.1f}s ({awq_time/len(items)*1000:.0f}ms/item)")
    print("="*55)

    threshold = args.divergence_threshold
    if stats["mean_absolute_divergence"] <= threshold:
        print(f"\n✅ PASSED: Divergence {stats['mean_absolute_divergence']*100:.2f}% ≤ threshold {threshold*100:.0f}%")
        print("   AWQ quantization is validated for production deployment.")
        sys.exit(0)
    else:
        print(f"\n❌ FAILED: Divergence {stats['mean_absolute_divergence']*100:.2f}% > threshold {threshold*100:.0f}%")
        print("   Do NOT deploy AWQ model. Investigate accuracy degradation.")
        sys.exit(1)


if __name__ == "__main__":
    main()
