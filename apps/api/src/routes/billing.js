import Stripe from 'stripe';
import { query } from '../db/index.js';
import { stripeEventQueue } from '../lib/queues.js';
import { logger } from '../lib/logger.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * @param {import('fastify').FastifyInstance} app
 */
export async function billingRoutes(app) {
  // ─── POST /api/v1/billing/subscribe ──────────────────────────────────────
  // Creates Stripe Customer + Subscription; returns client_secret for frontend
  app.post('/api/v1/billing/subscribe', {
    schema: {
      body: {
        type: 'object',
        required: ['user_id', 'email'],
        properties: {
          user_id: { type: 'string', format: 'uuid' },
          email: { type: 'string', format: 'email' },
        },
      },
    },
  }, async (req, reply) => {
    const { user_id, email } = req.body;

    // Check if user already has a subscription
    const existing = await query(
      `SELECT stripe_customer_id, stripe_subscription_id, status FROM subscriptions WHERE user_id = $1`,
      [user_id]
    );
    if (existing.rows.length) {
      return reply.send({
        message: 'Subscription already exists',
        subscription: existing.rows[0],
      });
    }

    // Create Stripe Customer
    const customer = await stripe.customers.create({
      email,
      metadata: { user_id },
    });

    // Create metered subscription
    // STRIPE_PRICE_ID should be set to your metered price ID from Stripe dashboard
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: process.env.STRIPE_PRICE_ID }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent', 'pending_setup_intent'],
    });

    const subscriptionItem = subscription.items.data[0];

    // Store in DB
    await query(
      `INSERT INTO subscriptions
         (user_id, stripe_customer_id, stripe_subscription_id, stripe_item_id, status, current_period_end)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
      [
        user_id,
        customer.id,
        subscription.id,
        subscriptionItem.id,
        subscription.status,
        subscription.current_period_end,
      ]
    );

    // Return client_secret for frontend to confirm payment method
    const clientSecret =
      subscription.pending_setup_intent?.client_secret ||
      subscription.latest_invoice?.payment_intent?.client_secret;

    reply.status(201).send({
      subscriptionId: subscription.id,
      customerId: customer.id,
      status: subscription.status,
      clientSecret,
    });
  });

  // ─── GET /api/v1/billing/subscription ────────────────────────────────────
  app.get('/api/v1/billing/subscription', {
    schema: {
      querystring: {
        type: 'object',
        required: ['user_id'],
        properties: { user_id: { type: 'string' } },
      },
    },
  }, async (req, reply) => {
    const { user_id } = req.query;
    const result = await query(
      `SELECT stripe_customer_id, stripe_subscription_id, status, current_period_end
       FROM subscriptions WHERE user_id = $1`,
      [user_id]
    );
    if (!result.rows.length) {
      return reply.status(404).send({ error: 'No subscription found' });
    }
    reply.send(result.rows[0]);
  });

  // ─── POST /api/v1/billing/portal ─────────────────────────────────────────
  // Generate Stripe Customer Portal session URL
  app.post('/api/v1/billing/portal', {
    schema: {
      body: {
        type: 'object',
        required: ['user_id'],
        properties: {
          user_id: { type: 'string' },
          return_url: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { user_id, return_url = process.env.FRONTEND_URL || 'http://localhost:5173' } = req.body;

    const sub = await query(
      `SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1`,
      [user_id]
    );
    if (!sub.rows.length) {
      return reply.status(404).send({ error: 'No subscription found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.rows[0].stripe_customer_id,
      return_url,
    });
    reply.send({ url: session.url });
  });

  // ─── POST /webhook/stripe ─────────────────────────────────────────────────
  // Stripe webhook receiver — must verify signature, be idempotent, non-blocking
  // Fastify must provide rawBody for signature verification
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      req.rawBody = body;
      try {
        done(null, JSON.parse(body.toString()));
      } catch (err) {
        done(err);
      }
    }
  );

  app.post('/webhook/stripe', async (req, reply) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      logger.warn({ err: err.message }, 'Stripe webhook signature verification failed');
      return reply.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ── Idempotency check ─────────────────────────────────────────────────
    const existing = await query(
      `SELECT id FROM payment_events WHERE stripe_event_id = $1`,
      [event.id]
    );
    if (existing.rows.length) {
      logger.info({ eventId: event.id }, 'Duplicate Stripe event — acknowledged, not reprocessed');
      return reply.send({ received: true, duplicate: true });
    }

    // ── Persist event record ──────────────────────────────────────────────
    await query(
      `INSERT INTO payment_events (stripe_event_id, event_type, status, payload)
       VALUES ($1, $2, 'received', $3)`,
      [event.id, event.type, JSON.stringify(event)]
    );

    // ── Enqueue for async processing — do NOT block webhook response ──────
    await stripeEventQueue.add('stripe-event', {
      eventId: event.id,
      eventType: event.type,
    }, {
      jobId: `stripe-${event.id}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
    });

    logger.info({ eventId: event.id, eventType: event.type }, 'Stripe webhook enqueued');
    reply.send({ received: true });
  });
}
