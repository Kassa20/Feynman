import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { registerTelemetry } from 'ai';
import { LangfuseVercelAiSdkIntegration } from '@langfuse/vercel-ai-sdk';

export const langfuseSpanProcessor = new LangfuseSpanProcessor();

const sdk = new NodeSDK({
    spanProcessors: [langfuseSpanProcessor],
});

sdk.start();

// Routes AI SDK 7 telemetry (streamText, generateText) into the OTel pipeline above.
registerTelemetry(new LangfuseVercelAiSdkIntegration());

// Traces are batched in memory. Flush them before the process dies, or you lose
// whatever was buffered — most visibly on `bun --watch` restarts during development.
const shutdown = async () => {
    await sdk.shutdown();
    process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);