import type { Database } from 'bun:sqlite'

export interface DatabaseMigration {
  version: number
  name: string
  up: (database: Database) => void
}

export const applicationMigrations: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: 'create_application_tables',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS mail_accounts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          provider TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '#6366f1',
          credentials_encrypted TEXT,
          sync_status TEXT NOT NULL DEFAULT 'idle',
          last_sync_at TEXT,
          unread_count INTEGER NOT NULL DEFAULT 0,
          signature TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE (id, user_id)
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          from_json TEXT NOT NULL DEFAULT '{}',
          to_json TEXT NOT NULL DEFAULT '[]',
          cc_json TEXT NOT NULL DEFAULT '[]',
          bcc_json TEXT NOT NULL DEFAULT '[]',
          subject TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          body_text TEXT NOT NULL DEFAULT '',
          body_html TEXT NOT NULL DEFAULT '',
          received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
          is_starred INTEGER NOT NULL DEFAULT 0 CHECK (is_starred IN (0, 1)),
          folder TEXT NOT NULL DEFAULT 'inbox',
          labels_json TEXT NOT NULL DEFAULT '[]',
          attachments_json TEXT NOT NULL DEFAULT '[]',
          snoozed_until TEXT,
          scheduled_at TEXT,
          read_receipt INTEGER NOT NULL DEFAULT 0 CHECK (read_receipt IN (0, 1)),
          provider_id TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          FOREIGN KEY (account_id, user_id)
            REFERENCES mail_accounts (id, user_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS irrelevant_messages (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
          account_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          sender_email TEXT NOT NULL DEFAULT '',
          sender_domain TEXT NOT NULL DEFAULT '',
          subject TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          labeled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          UNIQUE (user_id, message_id),
          FOREIGN KEY (account_id, user_id)
            REFERENCES mail_accounts (id, user_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS user_settings (
          user_id TEXT PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
          data_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );

        CREATE TABLE IF NOT EXISTS sync_cursors (
          account_id TEXT NOT NULL REFERENCES mail_accounts (id) ON DELETE CASCADE,
          scope TEXT NOT NULL,
          cursor_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (account_id, scope)
        );

        CREATE TABLE IF NOT EXISTS mutation_jobs (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          idempotency_key TEXT,
          last_error TEXT,
          next_attempt_at TEXT,
          completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          FOREIGN KEY (account_id, user_id)
            REFERENCES mail_accounts (id, user_id) ON DELETE CASCADE
        );
      `)
    },
  },
  {
    version: 2,
    name: 'create_application_indexes',
    up(database) {
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_mail_accounts_user_created
          ON mail_accounts (user_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_messages_user_folder_received
          ON messages (user_id, folder, received_at DESC);

        CREATE INDEX IF NOT EXISTS idx_messages_user_account_received
          ON messages (user_id, account_id, received_at DESC);

        CREATE INDEX IF NOT EXISTS idx_messages_user_thread_received
          ON messages (user_id, thread_id, received_at DESC);

        CREATE INDEX IF NOT EXISTS idx_messages_account_provider
          ON messages (account_id, provider_id)
          WHERE provider_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_messages_user_snoozed
          ON messages (user_id, snoozed_until)
          WHERE snoozed_until IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_messages_user_scheduled
          ON messages (user_id, scheduled_at)
          WHERE scheduled_at IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_irrelevant_messages_user_labeled
          ON irrelevant_messages (user_id, labeled_at DESC);

        CREATE INDEX IF NOT EXISTS idx_mutation_jobs_status_next_attempt
          ON mutation_jobs (status, next_attempt_at, created_at);

        CREATE INDEX IF NOT EXISTS idx_mutation_jobs_user_account_created
          ON mutation_jobs (user_id, account_id, created_at DESC);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_mutation_jobs_user_idempotency
          ON mutation_jobs (user_id, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
      `)
    },
  },
  {
    version: 3,
    name: 'add_message_importance',
    up(database) {
      database.exec(`
        ALTER TABLE messages
          ADD COLUMN is_important INTEGER NOT NULL DEFAULT 1 CHECK (is_important IN (0, 1));

        UPDATE messages
        SET is_important = EXISTS (
          SELECT 1 FROM json_each(
            CASE WHEN json_valid(messages.labels_json) THEN messages.labels_json ELSE '[]' END
          ) label
          WHERE label.value IN ('IMPORTANT', 'CATEGORY_PERSONAL')
        )
        WHERE EXISTS (
          SELECT 1 FROM mail_accounts account
          WHERE account.id = messages.account_id AND account.user_id = messages.user_id
            AND account.provider = 'gmail'
        );
      `)
    },
  },
  {
    version: 4,
    name: 'add_local_priority_learning',
    up(database) {
      database.exec(`
        CREATE TABLE priority_feedback (
          user_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          signal TEXT NOT NULL CHECK (signal IN (
            'attention', 'star', 'reply', 'irrelevant', 'important', 'other', 'spam', 'not-spam', 'archive'
          )),
          value INTEGER NOT NULL CHECK (
            (signal = 'attention' AND value BETWEEN 0 AND 120000)
            OR (signal <> 'attention' AND value = 1)
          ),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (user_id, account_id, thread_id, signal),
          FOREIGN KEY (account_id, user_id)
            REFERENCES mail_accounts (id, user_id) ON DELETE CASCADE
        );

        CREATE TABLE thread_priorities (
          user_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
          learned_category TEXT CHECK (learned_category IN ('important', 'other')),
          suggested_category TEXT CHECK (suggested_category IN ('important', 'other', 'spam')),
          override_category TEXT CHECK (override_category IN ('important', 'other')),
          reason TEXT NOT NULL,
          sample_count INTEGER NOT NULL DEFAULT 0 CHECK (sample_count >= 0),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (user_id, account_id, thread_id),
          FOREIGN KEY (account_id, user_id)
            REFERENCES mail_accounts (id, user_id) ON DELETE CASCADE
        );
      `)
    },
  },
  {
    version: 5,
    name: 'add_recoverable_quarantine',
    up(database) {
      database.exec(`
        CREATE TABLE quarantined_threads (
          user_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (user_id, account_id, thread_id),
          FOREIGN KEY (account_id, user_id)
            REFERENCES mail_accounts (id, user_id) ON DELETE CASCADE
        );
      `)
    },
  },
  {
    version: 6,
    name: 'add_needs_action_threads',
    up(database) {
      database.exec(`
        CREATE TABLE action_threads (
          user_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          PRIMARY KEY (user_id, account_id, thread_id),
          FOREIGN KEY (account_id, user_id)
            REFERENCES mail_accounts (id, user_id) ON DELETE CASCADE
        );
      `)
    },
  },
  {
    version: 7,
    name: 'add_sdk_inbox_views',
    up(database) {
      database.exec(`
        CREATE TABLE sdk_inbox_views (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
          account_id TEXT NOT NULL,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
          scopes_json TEXT NOT NULL CHECK (json_valid(scopes_json)),
          default_sender TEXT,
          FOREIGN KEY (account_id, user_id)
            REFERENCES mail_accounts (id, user_id) ON DELETE CASCADE
        );

        CREATE INDEX idx_sdk_inbox_views_user_account
          ON sdk_inbox_views (user_id, account_id);

        CREATE UNIQUE INDEX idx_messages_id_account_user
          ON messages (id, account_id, user_id);

        CREATE TABLE sdk_message_sources (
          user_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('domain', 'address')),
          value TEXT NOT NULL,
          PRIMARY KEY (user_id, account_id, message_id, kind, value),
          FOREIGN KEY (account_id, user_id)
            REFERENCES mail_accounts (id, user_id) ON DELETE CASCADE,
          FOREIGN KEY (message_id, account_id, user_id)
            REFERENCES messages (id, account_id, user_id) ON DELETE CASCADE
        );
      `)
    },
  },
]

export function getDatabaseSchemaVersion(database: Database): number {
  const table = database
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get('openmail_schema_migrations')

  if (!table) return 0

  return database
    .query<{ version: number }, []>(
      'SELECT COALESCE(MAX(version), 0) AS version FROM openmail_schema_migrations',
    )
    .get()!.version
}

export function runDatabaseMigrations(
  database: Database,
  migrations: readonly DatabaseMigration[] = applicationMigrations,
): number {
  let previousVersion = 0

  for (const migration of migrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error('Database migrations must have strictly increasing positive versions')
    }

    if (!/^[a-z][a-z\d_]*$/.test(migration.name)) {
      throw new Error(`Invalid database migration name for version ${migration.version}`)
    }

    previousVersion = migration.version
  }

  return database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS openmail_schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `)

    const applied = database
      .query<{ version: number; name: string }, []>(
        'SELECT version, name FROM openmail_schema_migrations ORDER BY version',
      )
      .all()
    const definitions = new Map(migrations.map((migration) => [migration.version, migration]))

    for (const recorded of applied) {
      const migration = definitions.get(recorded.version)

      if (!migration) {
        throw new Error(`Database schema version ${recorded.version} is newer than this application`)
      }

      if (migration.name !== recorded.name) {
        throw new Error(`Database migration ${recorded.version} does not match its recorded name`)
      }
    }

    const appliedVersions = new Set(applied.map((migration) => migration.version))
    const highestAppliedVersion = applied.at(-1)?.version ?? 0

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue

      if (migration.version < highestAppliedVersion) {
        throw new Error(`Database migration ${migration.version} is missing from migration history`)
      }

      migration.up(database)
      database
        .query('INSERT INTO openmail_schema_migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name)
    }

    return migrations.at(-1)?.version ?? 0
  }).immediate()
}
