const SHOPIFY_API_VERSION = '2024-01';

async function shopifyGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  const token  = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!domain || !token) throw new Error('SHOPIFY_STORE_DOMAIN / SHOPIFY_ADMIN_TOKEN not set');

  const res = await fetch(`https://${domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL HTTP ${res.status}`);
  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

const CONTRACT_QUERY = `
  query GetContracts($customerId: ID!) {
    customer(id: $customerId) {
      subscriptionContracts(first: 20) {
        nodes {
          id
          status
          lines(first: 10) { nodes { productId } }
        }
      }
    }
  }
`;

type ContractNode = {
  id: string;
  status: string;
  lines: { nodes: { productId: string }[] };
};

type ContractData = {
  customer: { subscriptionContracts: { nodes: ContractNode[] } } | null;
};

/**
 * Returns the Shopify subscription contract GID for a customer.
 * Filters by productId if SHOPIFY_SUBSCRIPTION_PRODUCT_ID is set,
 * handling the case where a customer has multiple subscriptions.
 * Returns null if not found or if env vars are missing.
 */
export async function findSubscriptionContractId(
  shopifyCustomerId: string,
): Promise<string | null> {
  if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_ADMIN_TOKEN) return null;

  const gid = shopifyCustomerId.startsWith('gid://')
    ? shopifyCustomerId
    : `gid://shopify/Customer/${shopifyCustomerId}`;

  const data = await shopifyGraphql<ContractData>(CONTRACT_QUERY, { customerId: gid });
  const contracts = data.customer?.subscriptionContracts.nodes ?? [];
  const active = contracts.filter((c) => c.status === 'ACTIVE');

  const productId = process.env.SHOPIFY_SUBSCRIPTION_PRODUCT_ID;
  if (productId) {
    // Match the contract whose lines include the configured product
    const match = active.find((c) =>
      c.lines.nodes.some((l) => {
        // productId in GraphQL is a GID: gid://shopify/Product/123456
        const numericId = l.productId.split('/').pop();
        return numericId === productId || l.productId === productId;
      }),
    );
    return match?.id ?? null;
  }

  return active[0]?.id ?? null;
}
