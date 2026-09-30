// Create order + soft-hold slot in ONE transaction. Price is computed server-side only.
import crypto from 'node:crypto';
import { prisma, json, errorResponse } from '../../../lib/services.js';
import { holdSlot } from '../../../../../src/lease/slots.js';

const PRICES_PAISE = { SIX_BY_FOUR: 3000, A4_PHOTO: 15000, A4_DOCUMENT: 2500 }; // example catalog
const SHIPPING_PAISE = 8000;

export async function POST(req) {
  try {
    const b = await req.json();
    const qty = Number(b.quantity);
    if (!PRICES_PAISE[b.product] || !Number.isInteger(qty) || qty < 1 || qty > 20) return json({ error: 'Invalid product/quantity' }, 400);
    if (!b.name || !/^\S+@\S+\.\S+$/.test(b.email || '') || !/^\d{10}$/.test(b.phone || '') || !b.address) {
      return json({ error: 'Invalid contact details' }, 400);
    }

    const order = await prisma.$transaction(async (tx) => {
      const o = await tx.order.create({
        data: {
          publicId: crypto.randomBytes(5).toString('hex').toUpperCase(),
          slotId: Number(b.slotId),
          product: b.product,
          quantity: qty,
          pricePaise: PRICES_PAISE[b.product] * qty + SHIPPING_PAISE,
          customerName: b.name, customerEmail: b.email, customerPhone: b.phone, shippingAddress: b.address,
        },
      });
      await holdSlot(tx, o.slotId, o.id); // throws 409 -> whole transaction rolls back
      return o;
    });

    // Next step (not shown): createOrder() with Cashfree and return paymentSessionId to the browser.
    return json({ publicId: order.publicId, pricePaise: order.pricePaise });
  } catch (err) {
    return errorResponse(err);
  }
}
