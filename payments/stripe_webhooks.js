/**
 * stripe_webhooks.js — Standalone Stripe webhook handler module.
 *
 * This module implements the full idempotent webhook pattern from PRD section 5.5.5.
 * It is also integrated directly into billing.js route — this file serves as the
 * canonical reference implementation for documentation purposes.
 *
 * Pattern:
 *   1. Verify stripe-signature header
 *   2. Idempotency check via stripe_event_id in payment_events table
 *   3. Persist event before processing
 *   4. Enqueue job — never process inline
 *   5. Return HTTP 200 within 2 seconds
 */
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Handle a Stripe webhook request.
 * Compatible with both Fastify and Express request/reply signatures.
 *
 * @param {object} rawBody - Raw request body (Buffer)
 * @param {string} signature - Value of stripe-signature header
 * @param {object} db - Database query function { query }
 * @param {object} queue - BullMQ queue { add }
 * @returns {Promise<{received: boolean, duplicate?: boolean}>}
 */
export async function handleStripeWebhook(rawBody, signature, { query, queue }) {
  // Step 1: Verify signature
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    const error = new Error(`Webhook signature verification failed: ${err.message}`);
    error.statusCode = 400;
    throw error;
  }

  // Step 2: Idempotency check
  const existing = await query(
    'SELECT id FROM payment_events WHERE stripe_event_id = $1',
    [event.id]
  );
  if (existing.rows.length) {
    return { received: true, duplicate: true };
  }

  // Step 3: Persist before processing
  await query(
    `INSERT INTO payment_events (stripe_event_id, event_type, status, payload)
     VALUES ($1, $2, 'received', $3)`,
    [event.id, event.type, JSON.stringify(event)]
  );

  // Step 4: Enqueue — do NOT process inline
  await queue.add('stripe-event', {
    eventId: event.id,
    eventType: event.type,
  }, {
    jobId: `stripe-${event.id}`,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
  });

  // Step 5: Return immediately (must be within 2 seconds total)
  return { received: true };
}
