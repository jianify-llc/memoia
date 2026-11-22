CREATE TABLE "memoia"."usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"recorded_at" timestamp (3) with time zone DEFAULT clock_timestamp() NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"usage" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memoia"."usage_events" ADD CONSTRAINT "usage_events_user_fk" FOREIGN KEY ("project_id","user_id") REFERENCES "memoia"."users"("project_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_project_date_idx" ON "memoia"."usage_events" USING btree ("project_id","recorded_at","id");--> statement-breakpoint
CREATE INDEX "usage_events_user_date_idx" ON "memoia"."usage_events" USING btree ("project_id","user_id","recorded_at","id");