import { z } from 'zod';

export const shopifySubscriptionSchema = z.object({
  id: z.union([z.number(), z.string()]).transform(String),
  email: z.string().email().nullable().optional(),
  contact_email: z.string().email().nullable().optional(),
  customer: z
    .object({
      email: z.string().email().nullable().optional(),
      first_name: z.string().nullable().optional(),
      last_name: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  line_items: z.array(
    z.object({
      selling_plan_id: z.number().nullable().optional(),
      product_id: z.number().nullable().optional(),
      quantity: z.number().int().positive(),
      title: z.string().optional(),
      price: z.string().optional(),
      sku: z.string().nullable().optional(),
    }),
  ),
});

export type ShopifySubscriptionPayload = z.infer<typeof shopifySubscriptionSchema>;

/** 3 fallbacks: order.email → contact_email → customer.email */
export const extractBuyerEmail = (o: ShopifySubscriptionPayload) =>
  o.email ?? o.contact_email ?? o.customer?.email ?? null;

export const extractBuyerName = (o: ShopifySubscriptionPayload) => {
  const fn = o.customer?.first_name;
  return fn ? `${fn} ${o.customer?.last_name ?? ''}`.trim() : undefined;
};

/** True si algún line_item tiene selling_plan_id (= suscripción). */
export const isSubscriptionOrder = (o: ShopifySubscriptionPayload) =>
  o.line_items.some((li) => li.selling_plan_id != null);
