// Vercel serverless function: public client config for live match rooms.
// Exposes ONLY the Supabase project URL and its publishable (anon) key — both are designed to be public
// and are protected by row-level security. Never put a service-role key in these variables.
// relay: false → on Vercel, rooms always run on Supabase Realtime (the in-memory relay needs `node server.js`).
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    relay: false,
  });
}
