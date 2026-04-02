"""
usage_reporter.py — Stripe usage record reporter.

Called after all batch items reach terminal status.
Reports consumed item count as metered usage to Stripe.

Idempotency: uses batch_id as idempotency key so even if the job is
retried (network failure, worker restart), Stripe will not double-bill.
"""
import os
import stripe

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]


class BatchUsageReportError(Exception):
    """Raised when Stripe usage reporting fails."""
    pass


async def report_batch_usage(
    subscription_item_id: str,
    item_count: int,
    batch_id: str,
) -> dict:
    """
    Report consumed item count as metered usage to Stripe.

    Args:
        subscription_item_id: Stripe SubscriptionItem ID (stripe_item_id column)
        item_count: Number of items analyzed in this batch
        batch_id: UUID of the batch — used as idempotency key

    Returns:
        Stripe UsageRecord object (dict)

    Raises:
        BatchUsageReportError: if Stripe call fails (log + caller should retry)
    """
    try:
        usage_record = stripe.SubscriptionItem.create_usage_record(
            subscription_item_id,
            quantity=item_count,
            timestamp="now",
            action="increment",
            idempotency_key=f"batch-usage-{batch_id}",  # Prevents double-reporting
        )
        return dict(usage_record)
    except stripe.error.StripeError as e:
        # Never swallow silently — raise so caller can log and enqueue for retry
        raise BatchUsageReportError(
            f"Stripe usage report failed for batch {batch_id}: {e.user_message}"
        ) from e
