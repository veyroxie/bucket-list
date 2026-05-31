// Optional shared-editing config.
// Leave as-is to run in local-only mode (data lives in your browser).
// To enable shared editing with someone you trust, follow README.md and fill these in.
window.BUCKET_CONFIG = {
  supabaseUrl: "",       // e.g. "https://xxxx.supabase.co"
  supabaseAnonKey: "",   // the public anon key
  sharedEmail: "",       // the shared auth account email you created
  // The passphrase itself is NEVER stored here. You and Jaevan type it
  // each session to unlock editing; it is the password for the shared
  // Supabase account and is verified server-side.
};
