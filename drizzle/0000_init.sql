CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"release_reason" varchar(32),
	CONSTRAINT "chk_release_after_start" CHECK ("usage_history"."released_at" IS NULL OR "usage_history"."released_at" >= "usage_history"."started_at")
);
--> statement-breakpoint
ALTER TABLE "usage_history" ADD CONSTRAINT "usage_history_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_usage_history_token_id" ON "usage_history" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "ix_usage_history_token_started" ON "usage_history" USING btree ("token_id","started_at");--> statement-breakpoint
CREATE INDEX "ix_usage_history_open" ON "usage_history" USING btree ("token_id") WHERE "usage_history"."released_at" IS NULL;