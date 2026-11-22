ALTER TABLE "memoia"."memory_operations" DROP CONSTRAINT "ck_memory_flush_lease";--> statement-breakpoint
ALTER TABLE "memoia"."memory_operations" DROP CONSTRAINT "memory_operations_kind_check";--> statement-breakpoint
ALTER TABLE "memoia"."memory_blobs" ADD COLUMN "external_id" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_memory_blob_external_id" ON "memoia"."memory_blobs" USING btree ("user_id","project_id","external_id") WHERE external_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "memoia"."memory_operations" ADD CONSTRAINT "ck_memory_flush_lease" CHECK (((lease_owner IS NULL) = (lease_until IS NULL)) AND (attempts BETWEEN 0 AND 4) AND (kind = 'flush' OR (lease_owner IS NULL AND ((kind = 'append' AND fact_flush_id IS NOT NULL) OR (attempts = 0 AND available_at IS NULL)))));--> statement-breakpoint
ALTER TABLE "memoia"."memory_operations" ADD CONSTRAINT "memory_operations_kind_check" CHECK ((kind)::text = ANY (ARRAY[('import'::character varying)::text, ('retract'::character varying)::text, ('correct'::character varying)::text, ('legacy_import'::character varying)::text, ('flush'::character varying)::text, ('fact_flush'::character varying)::text, ('append'::character varying)::text]));
--> statement-breakpoint
COMMENT ON COLUMN memoia.memory_blobs.external_id IS '同一项目和用户内的会话 Blob 对外 ID';
--> statement-breakpoint
