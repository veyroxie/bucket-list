# bucket list

a small, private bucket list. editorial typography, ink-on-cream, lives wherever you put it.

## try it locally

Open `index.html` in any modern browser. Done — there is no build step.

Add items by typing in the field at the top. Inline syntax:

| token             | meaning                                            |
| ----------------- | -------------------------------------------------- |
| `#me`             | tags it as yours                                   |
| `#jaevan`         | tags it as Jaevan's                                |
| `#us`             | tags it as shared                                  |
| `#anything`       | adds a free-form tag                               |
| `!high` `!med` `!low` | sets priority (default is low / "someday")     |

Examples:

```
hike kyoto #us #travel !high
finish my book #me !med
learn surfing #jaevan
```

Keyboard:

- `⌘K` / `Ctrl+K` — jump to the add field from anywhere
- `Enter` in the title — save edits
- `Esc` — cancel an inline edit
- Drag any row to reorder

The epigraph (italic line at the top) is editable — click it.

## deploy to github pages

1. Create a repo on GitHub (e.g. `bucket-list`).
2. Push these files to `main`.
3. Repo Settings → Pages → Source: `Deploy from a branch` → `main` / `(root)` → Save.
4. Within ~1 minute you'll have a live URL at `https://<your-username>.github.io/bucket-list/`.

That's it. The site is fully static — no build, no server.

## shared editing with Jaevan (optional)

In local-only mode the list lives in your browser. If you want Jaevan to be able
to edit from his own device too — without making it public to the world — set up
a small free Supabase backend. Anyone with the URL can read, but only people who
know your shared passphrase can edit.

### one-time setup (~10 minutes)

1. **Create a Supabase project** at [supabase.com](https://supabase.com) (free tier).

2. **Create the shared auth account first.** Authentication → Users → "Add user"
   → "Create new user". Use any email you control (e.g. `bucket-list@yourdomain.com`)
   and a strong passphrase — this passphrase is what you and Jaevan will both type
   to unlock editing. Mark the user as confirmed. Copy the user's **UID** from
   the user row; you'll paste it into the SQL below.

3. **Disable public sign-ups** so nobody else can create an account and then
   write. Authentication → Providers → Email → turn off **Enable Sign Ups**.
   Keep email enabled for sign-*in*. Without this step anyone with the anon
   key (which ships in `config.js`) could sign themselves up and write.

4. **Create the table, policies, and realtime publication.** SQL editor → run:

   ```sql
   create table bucket_list (
     id integer primary key,
     payload jsonb not null default '{"items":[]}'::jsonb,
     updated_at timestamptz not null default now()
   );
   insert into bucket_list (id, payload) values (1, '{"items":[]}'::jsonb);

   alter table bucket_list enable row level security;

   create policy "anyone can read" on bucket_list
     for select using (true);

   -- replace 'PASTE-SHARED-UID-HERE' with the UID from step 2
   create policy "only shared account can write" on bucket_list
     for all
     using (auth.uid() = 'PASTE-SHARED-UID-HERE'::uuid)
     with check (auth.uid() = 'PASTE-SHARED-UID-HERE'::uuid);

   -- enable realtime so live edits sync between you two
   alter publication supabase_realtime add table bucket_list;
   ```

   The UID-pinned write policy means even if someone else somehow gets an
   authenticated session, they still can't write. Belt and braces.

5. **Get your keys.** Project Settings → API → copy the `URL` and the `anon` key.

6. **Fill in `assets/config.js`:**

   ```js
   window.BUCKET_CONFIG = {
     supabaseUrl: "https://xxxx.supabase.co",
     supabaseAnonKey: "ey…",
     sharedEmail: "bucket-list@yourdomain.com",
   };
   ```

   The passphrase itself is never stored in the code — you and Jaevan type it
   each session to unlock editing.

7. Push, refresh the live site. You'll see `view only` in the footer with an
   `unlock editing` link. Click, enter the passphrase, edit. Lock when done.
   When one of you edits, the other's view updates live within a second or so.

### threat model — what this does and doesn't protect against

- Anyone with the URL can **read** the list. Use a non-guessable repo name if
  that matters.
- Only the holder of the passphrase can **edit**. The passphrase is verified by
  Supabase server-side; the JS in this repo never sees it. Public sign-ups are
  disabled and writes are pinned to the shared account's UID — both layers
  must be in place.
- This is not built for an adversarial threat model. It's built for "a couple
  sharing a private list without anyone else being able to change it."

## customisation

- **Palette, type, motion** — `assets/style.css` top section is all CSS custom
  properties.
- **Header copy** — edit the `<h1 class="title">` in `index.html`.
- **Epigraph default** — `the years are short.` in `index.html`. (Click to edit
  in-app at any time; your edit is remembered locally.)

## what lives where

```
bucket-list/
├── index.html          # markup
├── assets/
│   ├── style.css       # design system
│   ├── app.js          # all behavior
│   └── config.js       # optional Supabase config
└── README.md
```

No frameworks, no build, no package.json. Open the files and read them — that's
the whole program.
