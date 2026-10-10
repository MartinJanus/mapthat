import { createWebhookHandlers } from "../../../../features/instagram/webhook";

export const runtime = "nodejs";

const handlers = createWebhookHandlers({ environment: () => process.env });

export const GET = handlers.GET;
export const POST = handlers.POST;
