// Registers all hosting providers. Import once from server-side entrypoints
// (server functions, hook routes) so the registry is populated before
// getHostingProvider() is called — same contract as @/server/edge.
import { registerHostingProvider } from "./providers";
import { vercelProvider } from "./vercel-provider";
import { manualProvider } from "./manual-provider";

registerHostingProvider(vercelProvider);
registerHostingProvider(manualProvider);

export * from "./providers";
