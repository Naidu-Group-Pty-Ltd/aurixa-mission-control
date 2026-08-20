// TanStack Start instance. Registering one changes two things at once, and both
// matter:
//
//  1. `functionMiddleware` here runs for EVERY server function, which is where
//     the generated `attachSupabaseAuth` was always meant to live (its own
//     header says so). Without it the module is unreferenced, tree-shaken out
//     of the client bundle, and the bearer token reaches server functions only
//     via the `window.fetch` patch in `src/lib/auth.tsx`.
//
//  2. `requestMiddleware` REPLACES the framework's default. Read
//     `createStartHandler`: it uses `[defaultCsrfMiddleware]` only while no
//     start instance exists, and hands over entirely to `startOptions
//     .requestMiddleware` the moment one does. Registering an instance without
//     a CSRF middleware therefore switches CSRF protection off for every
//     server function — silently, with the app still working. The filter below
//     is byte-for-byte the framework's own default.
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  functionMiddleware: [attachSupabaseAuth],
}));
