// Optional shared-editing config.
// To enable shared editing with someone you trust, follow README.md and fill these in.
// Leave empty to run in local-only mode (data lives in your browser).
window.BUCKET_CONFIG = {
  supabaseUrl: "https://xjinqdraqhthcugtwhel.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqaW5xZHJhcWh0aGN1Z3R3aGVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzMjQ5NzcsImV4cCI6MjA5NTkwMDk3N30.4GaSdozd-ICya24WXZwGcR0yAFwzdRnXhFSvLt8IXIo",
  // Either set sharedEmail (one account) OR sharedEmails (multiple accounts,
  // each with their own passphrase). When sharedEmails is set, the unlock
  // form tries each email in turn with whatever password is typed — so each
  // person can have their own password.
  sharedEmails: ["etee3001@gmail.com", "jaevankugan01@gmail.com"],
  // Passphrases are NEVER stored here. Each person types their own
  // passphrase each session; it's the password for their Supabase account
  // and is verified server-side.
};
