import {
  pgSchema,
  varchar,
  index,
  foreignKey,
  unique,
  check,
  uuid,
  jsonb,
  timestamp,
  boolean,
  bigint,
  text,
  integer,
  uniqueIndex,
  primaryKey,
  date,
  customType,
  type AnyPgColumn,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { taskColumns, taskConstraints } from "@jianify/legato/schema";

const vector1536 = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(1536)",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => JSON.parse(value),
});

export const memoia = pgSchema("memoia");

export const alembicVersionInMemoia = memoia.table("alembic_version", {
  versionNum: varchar("version_num", { length: 32 }).primaryKey().notNull(),
});

export const memoryFactsInMemoia = memoia.table(
  "memory_facts",
  {
    id: uuid().primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    blobId: uuid("blob_id").notNull(),
    content: varchar().notNull(),
    topic: varchar({ length: 128 }),
    subTopic: varchar("sub_topic", { length: 128 }),
    supportGroups: jsonb("support_groups").notNull(),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    included: boolean().default(true).notNull(),
    factTime: jsonb("fact_time"),
    subject: varchar({ length: 512 }),
    reporter: varchar({ length: 512 }),
    certainty: varchar({ length: 16 }).default("legacy").notNull(),
    revision: bigint({ mode: "bigint" })
      .default(sql`1`)
      .notNull(),
    createdVersion: bigint("created_version", { mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    searchText: text("search_text"),
    embedding: vector1536("embedding"),
    createdAt: timestamp("created_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
    updatedAt: timestamp("updated_at", {
      withTimezone: true,
      mode: "string",
    }).defaultNow(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_memory_facts_lexical").using(
      "gin",
      sql`to_tsvector('simple'::regconfig, COALESCE(search_text, content::text))`,
    ),
    index("idx_memory_facts_user").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.blobId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.blobId, table.userId, table.projectId],
      foreignColumns: [
        memoryBlobsInMemoia.id as AnyPgColumn,
        memoryBlobsInMemoia.userId as AnyPgColumn,
        memoryBlobsInMemoia.projectId as AnyPgColumn,
      ],
      name: "memory_facts_blob_id_user_id_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "memory_facts_user_id_project_id_fkey",
    }).onDelete("cascade"),
    unique("uq_memory_facts_owner").on(table.id, table.userId, table.projectId),
    check(
      "ck_memory_facts_certainty",
      sql`(certainty)::text = ANY (ARRAY[('legacy'::character varying)::text, ('asserted'::character varying)::text, ('reported'::character varying)::text, ('uncertain'::character varying)::text])`,
    ),
    check(
      "ck_memory_facts_revision",
      sql`(revision > 0) AND (created_version >= 0)`,
    ),
  ],
);

export const billingsInMemoia = memoia.table("billings", {
  usageLeft: integer("usage_left"),
  nextRefillAt: timestamp("next_refill_at", {
    withTimezone: true,
    mode: "string",
  }),
  id: uuid().primaryKey().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
    .defaultNow()
    .notNull(),
});

export const memoryOperationsInMemoia = memoia.table(
  "memory_operations",
  {
    id: uuid().primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 255 }).notNull(),
    kind: varchar({ length: 16 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    request: jsonb().notNull(),
    blobId: uuid("blob_id"),
    status: varchar({ length: 16 }).notNull(),
    result: jsonb(),
    error: jsonb(),
    generation: bigint({ mode: "bigint" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    sourceId: varchar("source_id", { length: 255 }),
    inputExpiresAt: timestamp("input_expires_at", {
      withTimezone: true,
      mode: "string",
    }),
    leaseOwner: uuid("lease_owner"),
    leaseUntil: timestamp("lease_until", {
      withTimezone: true,
      mode: "string",
    }),
    attempts: bigint({ mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    availableAt: timestamp("available_at", {
      withTimezone: true,
      mode: "string",
    }),
    dispatchReservedUntil: timestamp("dispatch_reserved_until", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_memory_flush_ready")
      .using("btree", table.availableAt.asc().nullsLast())
      .where(
        sql`(((kind)::text = 'flush'::text) AND ((status)::text <> 'completed'::text))`,
      ),
    index("idx_memory_operations_user").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    uniqueIndex("uq_memory_fact_operation_blob")
      .using("btree", table.blobId.asc().nullsLast())
      .where(
        sql`((kind)::text = ANY (ARRAY[('import'::character varying)::text, ('retract'::character varying)::text, ('correct'::character varying)::text]))`,
      ),
    uniqueIndex("uq_memory_flush_executor")
      .using(
        "btree",
        table.userId.asc().nullsLast(),
        table.projectId.asc().nullsLast(),
      )
      .where(
        sql`(((kind)::text = 'flush'::text) AND (lease_owner IS NOT NULL))`,
      ),
    foreignKey({
      columns: [table.blobId, table.userId, table.projectId],
      foreignColumns: [
        memoryBlobsInMemoia.id as AnyPgColumn,
        memoryBlobsInMemoia.userId as AnyPgColumn,
        memoryBlobsInMemoia.projectId as AnyPgColumn,
      ],
      name: "memory_operations_blob_id_user_id_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.blobId, table.userId, table.projectId, table.sourceId],
      foreignColumns: [
        memoryBlobsInMemoia.id as AnyPgColumn,
        memoryBlobsInMemoia.userId as AnyPgColumn,
        memoryBlobsInMemoia.projectId as AnyPgColumn,
        memoryBlobsInMemoia.sourceId as AnyPgColumn,
      ],
      name: "memory_operations_blob_id_user_id_project_id_source_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "memory_operations_user_id_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.projectId, table.sourceId],
      foreignColumns: [
        memorySourcesInMemoia.userId,
        memorySourcesInMemoia.projectId,
        memorySourcesInMemoia.sourceId,
      ],
      name: "memory_operations_user_id_project_id_source_id_fkey",
    }).onDelete("cascade"),
    unique("memory_operations_id_user_id_project_id_key").on(
      table.id,
      table.userId,
      table.projectId,
    ),
    unique("memory_operations_id_user_id_project_id_source_id_key").on(
      table.id,
      table.userId,
      table.projectId,
      table.sourceId,
    ),
    unique("memory_operations_user_id_project_id_idempotency_key_key").on(
      table.userId,
      table.projectId,
      table.idempotencyKey,
    ),
    check(
      "ck_memory_fact_operation_blob",
      sql`((kind)::text <> ALL (ARRAY[('import'::character varying)::text, ('retract'::character varying)::text, ('correct'::character varying)::text])) OR (blob_id IS NOT NULL)`,
    ),
    check(
      "ck_memory_flush_lease",
      sql`((lease_owner IS NULL) = (lease_until IS NULL)) AND ((attempts >= 0) AND (attempts <= 4)) AND (((kind)::text = 'flush'::text) OR ((lease_owner IS NULL) AND (attempts = 0) AND (available_at IS NULL)))`,
    ),
    check(
      "ck_memory_operation_scope",
      sql`(((kind)::text = 'flush'::text) AND (source_id IS NULL) AND (blob_id IS NULL)) OR (((kind)::text <> 'flush'::text) AND (source_id IS NOT NULL))`,
    ),
    check(
      "memory_operations_completion_check",
      sql`(((status)::text <> 'completed'::text) OR ((result IS NOT NULL) AND (error IS NULL) AND (((kind)::text <> 'import'::text) OR (blob_id IS NOT NULL)))) AND (((status)::text <> 'failed'::text) OR (error IS NOT NULL))`,
    ),
    check(
      "memory_operations_kind_check",
      sql`(kind)::text = ANY (ARRAY[('import'::character varying)::text, ('retract'::character varying)::text, ('correct'::character varying)::text, ('legacy_import'::character varying)::text, ('flush'::character varying)::text])`,
    ),
    check(
      "memory_operations_legacy_receipt_check",
      sql`((kind)::text <> 'legacy_import'::text) OR (((status)::text = 'completed'::text) AND (blob_id IS NOT NULL) AND (result IS NOT NULL) AND (error IS NULL) AND (NOT (request ? 'messages'::text)))`,
    ),
    check(
      "memory_operations_status_check",
      sql`(status)::text = ANY (ARRAY[('processing'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])`,
    ),
  ],
);

export const queueTasksInMemoia = memoia.table(
  "queue_tasks",
  taskColumns({ id: "uuid" }),
  (table): PgTableExtraConfigValue[] => [
    ...taskConstraints(table),
    foreignKey({
      columns: [table.id],
      foreignColumns: [memoryOperationsInMemoia.id],
      name: "queue_tasks_operation_fkey",
    }).onDelete("cascade"),
  ],
);

export const memoryProfileRevisionsInMemoia = memoia.table(
  "memory_profile_revisions",
  {
    id: uuid().primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    operationId: uuid("operation_id"),
    sourceId: varchar("source_id", { length: 255 }),
    profiles: jsonb().notNull(),
    added: jsonb().notNull(),
    removed: jsonb().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    maintenanceVersion: bigint("maintenance_version", { mode: "bigint" }),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_memory_profile_revisions_user").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [memoryOperationsInMemoia.id as AnyPgColumn],
      name: "memory_profile_revisions_operation_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        table.operationId,
        table.userId,
        table.projectId,
        table.sourceId,
      ],
      foreignColumns: [
        memoryOperationsInMemoia.id as AnyPgColumn,
        memoryOperationsInMemoia.userId as AnyPgColumn,
        memoryOperationsInMemoia.projectId as AnyPgColumn,
        memoryOperationsInMemoia.sourceId as AnyPgColumn,
      ],
      name: "memory_profile_revisions_operation_id_user_id_project_id_s_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "memory_profile_revisions_user_id_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.projectId, table.sourceId],
      foreignColumns: [
        memorySourcesInMemoia.userId,
        memorySourcesInMemoia.projectId,
        memorySourcesInMemoia.sourceId,
      ],
      name: "memory_profile_revisions_user_id_project_id_source_id_fkey",
    }).onDelete("cascade"),
    unique("uq_profile_maintenance").on(
      table.userId,
      table.projectId,
      table.maintenanceVersion,
    ),
    unique("memory_profile_revisions_operation_id_key").on(table.operationId),
  ],
);

export const projectApiKeysInMemoia = memoia.table(
  "project_api_keys",
  {
    id: uuid().primaryKey().notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    name: varchar({ length: 128 }).notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    scopes: jsonb().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_project_api_keys_project").using(
      "btree",
      table.projectId.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [projectsInMemoia.projectId],
      name: "project_api_keys_project_id_fkey",
    }).onDelete("cascade"),
    check(
      "project_api_keys_scopes_check",
      sql`(jsonb_array_length(scopes) >= 1) AND (jsonb_array_length(scopes) <= 3)`,
    ),
    check(
      "project_api_keys_scopes_check1",
      sql`scopes <@ '["read", "write", "admin"]'::jsonb`,
    ),
  ],
);

export const memoryUserStatesInMemoia = memoia.table(
  "memory_user_states",
  {
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    generation: bigint({ mode: "bigint" })
      .default(sql`'0'`)
      .notNull(),
    version: bigint({ mode: "bigint" })
      .default(sql`'0'`)
      .notNull(),
    writerLeaseUntil: timestamp("writer_lease_until", {
      withTimezone: true,
      mode: "string",
    }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "memory_user_states_user_id_project_id_fkey",
    }).onDelete("cascade"),
    unique("memory_user_states_user_id_project_id_key").on(
      table.userId,
      table.projectId,
    ),
  ],
);

export const memoryBlobsInMemoia = memoia.table(
  "memory_blobs",
  {
    id: uuid().primaryKey().notNull(),
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    status: varchar({ length: 16 }).notNull(),
    eventId: uuid("event_id"),
    eventDeleted: boolean("event_deleted").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    sourceId: varchar("source_id", { length: 255 }).notNull(),
    messageIds: jsonb("message_ids").notNull(),
    kind: varchar({ length: 16 }).default("import").notNull(),
    factChanges: jsonb("fact_changes").default([]).notNull(),
    factCompletedAt: timestamp("fact_completed_at", {
      withTimezone: true,
      mode: "string",
    }),
    flushOperationId: uuid("flush_operation_id"),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_memory_blob_unflushed")
      .using(
        "btree",
        table.userId.asc().nullsLast(),
        table.projectId.asc().nullsLast(),
        table.factCompletedAt.asc().nullsLast(),
        table.id.asc().nullsLast(),
      )
      .where(
        sql`((flush_operation_id IS NULL) AND (fact_completed_at IS NOT NULL))`,
      ),
    index("idx_memory_blobs_group").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.sourceId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    index("idx_memory_blobs_message_ids").using(
      "gin",
      table.messageIds.asc().nullsLast(),
    ),
    index("idx_memory_sources_user").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.createdAt.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.flushOperationId, table.userId, table.projectId],
      foreignColumns: [
        memoryOperationsInMemoia.id as AnyPgColumn,
        memoryOperationsInMemoia.userId as AnyPgColumn,
        memoryOperationsInMemoia.projectId as AnyPgColumn,
      ],
      name: "fk_memory_blob_flush",
    }),
    foreignKey({
      columns: [table.userId, table.projectId, table.sourceId],
      foreignColumns: [
        memorySourcesInMemoia.userId,
        memorySourcesInMemoia.projectId,
        memorySourcesInMemoia.sourceId,
      ],
      name: "memory_blobs_user_id_project_id_source_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "memory_sources_user_id_project_id_fkey",
    }).onDelete("cascade"),
    unique("memory_blobs_id_user_id_project_id_key").on(
      table.id,
      table.userId,
      table.projectId,
    ),
    unique("memory_blobs_id_user_id_project_id_source_id_key").on(
      table.id,
      table.userId,
      table.projectId,
      table.sourceId,
    ),
    check(
      "ck_memory_blob_changes",
      sql`jsonb_typeof(fact_changes) = 'array'::text`,
    ),
    check(
      "ck_memory_blob_kind",
      sql`(kind)::text = ANY (ARRAY[('import'::character varying)::text, ('retract'::character varying)::text, ('correct'::character varying)::text])`,
    ),
    check(
      "memory_sources_status_check",
      sql`(status)::text = ANY (ARRAY[('active'::character varying)::text, ('retracted'::character varying)::text, ('rebuilding'::character varying)::text])`,
    ),
  ],
);

export const projectsInMemoia = memoia.table(
  "projects",
  {
    projectId: varchar("project_id", { length: 64 }).primaryKey().notNull(),
    projectSecret: varchar("project_secret", { length: 255 }).notNull(),
    profileConfig: text("profile_config"),
    status: varchar({ length: 16 }).notNull(),
    id: uuid().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_projects_project_id").using(
      "btree",
      table.projectId.asc().nullsLast(),
    ),
  ],
);

export const memoryDeletedEventsInMemoia = memoia.table(
  "memory_deleted_events",
  {
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    id: uuid().notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "memory_deleted_events_user_id_project_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.userId, table.projectId, table.id],
      name: "memory_deleted_events_pkey",
    }),
  ],
);

export const memoryUserTombstonesInMemoia = memoia.table(
  "memory_user_tombstones",
  {
    projectId: varchar("project_id", { length: 64 }).notNull(),
    userId: uuid("user_id").notNull(),
    forgottenAt: timestamp("forgotten_at", {
      withTimezone: true,
      mode: "string",
    })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [projectsInMemoia.projectId],
      name: "memory_user_tombstones_project_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.userId],
      name: "memory_user_tombstones_pkey",
    }),
  ],
);

export const projectBillingsInMemoia = memoia.table(
  "project_billings",
  {
    projectId: varchar("project_id", { length: 64 }).notNull(),
    billingId: uuid("billing_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_project_billings_billing_id").using(
      "btree",
      table.billingId.asc().nullsLast(),
    ),
    index("idx_project_billings_project_id").using(
      "btree",
      table.projectId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.billingId],
      foreignColumns: [billingsInMemoia.id],
      name: "project_billings_billing_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [projectsInMemoia.projectId],
      name: "project_billings_project_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.billingId],
      name: "project_billings_pkey",
    }),
  ],
);

export const memoryEventFactsInMemoia = memoia.table(
  "memory_event_facts",
  {
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    eventId: uuid("event_id").notNull(),
    factId: uuid("fact_id").notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_memory_event_facts_reverse").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.factId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.eventId, table.userId, table.projectId],
      foreignColumns: [
        userEventsInMemoia.id,
        userEventsInMemoia.userId,
        userEventsInMemoia.projectId,
      ],
      name: "memory_event_facts_event_id_user_id_project_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.factId, table.userId, table.projectId],
      foreignColumns: [
        memoryFactsInMemoia.id,
        memoryFactsInMemoia.userId,
        memoryFactsInMemoia.projectId,
      ],
      name: "memory_event_facts_fact_id_user_id_project_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.eventId, table.factId],
      name: "memory_event_facts_pkey",
    }),
  ],
);

export const memorySourcesInMemoia = memoia.table(
  "memory_sources",
  {
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    sourceId: varchar("source_id", { length: 255 }).notNull(),
    legacy: boolean().default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "memory_sources_user_id_project_id_fkey1",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.userId, table.projectId, table.sourceId],
      name: "memory_sources_pkey1",
    }),
  ],
);

export const usersInMemoia = memoia.table(
  "users",
  {
    additionalFields: jsonb("additional_fields"),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    id: uuid().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_users_id_project_id").using(
      "btree",
      table.id.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [projectsInMemoia.projectId],
      name: "users_project_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({ columns: [table.projectId, table.id], name: "users_pkey" }),
  ],
);

export const usageCountersInMemoia = memoia.table(
  "usage_counters",
  {
    projectId: varchar("project_id", { length: 64 }).notNull(),
    name: varchar({ length: 128 }).notNull(),
    periodType: varchar("period_type", { length: 5 }).notNull(),
    periodStart: date("period_start").notNull(),
    value: bigint({ mode: "bigint" })
      .default(sql`0`)
      .notNull(),
    expiresAt: timestamp("expires_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_usage_counters_expires_at").using(
      "btree",
      table.expiresAt.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [projectsInMemoia.projectId],
      name: "usage_counters_project_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [
        table.projectId,
        table.name,
        table.periodType,
        table.periodStart,
      ],
      name: "usage_counters_pkey",
    }),
    check(
      "usage_counters_period_type_check",
      sql`(period_type)::text = ANY ((ARRAY['day'::character varying, 'month'::character varying])::text[])`,
    ),
  ],
);

export const userStatusesInMemoia = memoia.table(
  "user_statuses",
  {
    type: varchar({ length: 32 }).notNull(),
    attributes: jsonb().notNull(),
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    id: uuid().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_user_statuses_user_id_id_project_id").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    index("idx_user_statuses_user_id_project_id").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
    ),
    index("idx_user_statuses_user_id_project_id_type").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.type.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "user_statuses_user_id_project_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.id],
      name: "user_statuses_pkey",
    }),
  ],
);

export const generalBlobsInMemoia = memoia.table(
  "general_blobs",
  {
    userId: uuid("user_id").notNull(),
    blobType: varchar("blob_type", { length: 16 }).notNull(),
    blobData: jsonb("blob_data").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    additionalFields: jsonb("additional_fields"),
    id: uuid().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("idx_general_blobs_id_project_id").using(
      "btree",
      table.id.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
    ),
    index("idx_general_blobs_user_id_blob_type").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.blobType.asc().nullsLast(),
    ),
    index("idx_general_blobs_user_id_id").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    index("idx_general_blobs_user_id_project_id").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "general_blobs_user_id_project_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.id],
      name: "general_blobs_pkey",
    }),
  ],
);

export const userEventsInMemoia = memoia.table(
  "user_events",
  {
    eventData: jsonb("event_data").notNull(),
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    embedding: vector1536("embedding"),
    id: uuid().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    revision: bigint({ mode: "bigint" })
      .default(sql`1`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_user_events_lexical").using(
      "gin",
      sql`to_tsvector('simple'::regconfig, COALESCE(event_data ->> 'event_tip', ''))`,
    ),
    index("idx_user_events_user_id_id_project_id").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    index("idx_user_events_user_id_project_id").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "user_events_user_id_project_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.id],
      name: "user_events_pkey",
    }),
    unique("uq_user_events_owner").on(table.userId, table.projectId, table.id),
  ],
);

export const userProfilesInMemoia = memoia.table(
  "user_profiles",
  {
    content: text().notNull(),
    userId: uuid("user_id").notNull(),
    attributes: jsonb(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    id: uuid().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    revision: bigint({ mode: "bigint" })
      .default(sql`1`)
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_user_profiles_user_id_id_project_id").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.id.asc().nullsLast(),
    ),
    index("idx_user_profiles_user_id_project_id").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "user_profiles_user_id_project_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.id],
      name: "user_profiles_pkey",
    }),
  ],
);

export const bufferZonesInMemoia = memoia.table(
  "buffer_zones",
  {
    blobType: varchar("blob_type", { length: 16 }).notNull(),
    tokenSize: integer("token_size").notNull(),
    userId: uuid("user_id").notNull(),
    blobId: uuid("blob_id").notNull(),
    status: varchar({ length: 16 }).notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    id: uuid().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    index("idx_buffer_zones_user_id_blob_type").using(
      "btree",
      table.userId.asc().nullsLast(),
      table.projectId.asc().nullsLast(),
      table.blobType.asc().nullsLast(),
      table.status.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.blobId, table.projectId],
      foreignColumns: [generalBlobsInMemoia.id, generalBlobsInMemoia.projectId],
      name: "buffer_zones_blob_id_project_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    foreignKey({
      columns: [table.userId, table.projectId],
      foreignColumns: [usersInMemoia.id, usersInMemoia.projectId],
      name: "buffer_zones_user_id_project_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    primaryKey({
      columns: [table.projectId, table.id],
      name: "buffer_zones_pkey",
    }),
  ],
);

export const memoryMessagesInMemoia = memoia.table(
  "memory_messages",
  {
    userId: uuid("user_id").notNull(),
    projectId: varchar("project_id", { length: 64 }).notNull(),
    sourceId: varchar("source_id", { length: 255 }).notNull(),
    messageId: varchar("message_id", { length: 255 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }),
    role: varchar({ length: 16 }),
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }),
    processed: boolean().default(false).notNull(),
    deleted: boolean().default(false).notNull(),
    timeZone: varchar("time_zone", { length: 100 }),
  },
  (table): PgTableExtraConfigValue[] => [
    foreignKey({
      columns: [table.userId, table.projectId, table.sourceId],
      foreignColumns: [
        memorySourcesInMemoia.userId,
        memorySourcesInMemoia.projectId,
        memorySourcesInMemoia.sourceId,
      ],
      name: "memory_messages_user_id_project_id_source_id_fkey",
    }).onDelete("cascade"),
    primaryKey({
      columns: [table.userId, table.projectId, table.sourceId, table.messageId],
      name: "memory_messages_pkey",
    }),
    check(
      "memory_messages_check",
      sql`deleted OR ((content_hash IS NOT NULL) AND (role IS NOT NULL) AND (occurred_at IS NOT NULL))`,
    ),
  ],
);
