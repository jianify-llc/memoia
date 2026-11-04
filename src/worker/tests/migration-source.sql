-- Isolated migration fixture only. Never install this data in a shared environment.
BEGIN;
SET LOCAL search_path TO memoia,extensions,public;
INSERT INTO alembic_version VALUES ('0016_source_cascade') ON CONFLICT DO NOTHING;
INSERT INTO projects(id,project_id,project_secret,status) VALUES ('00000000-0000-4000-8000-000000000001','migration-fixture','local-only','active');
INSERT INTO users(id,project_id) VALUES ('00000000-0000-4000-8000-000000000002','migration-fixture');
INSERT INTO memory_sources(user_id,project_id,source_id) VALUES ('00000000-0000-4000-8000-000000000002','migration-fixture','dialog');
INSERT INTO memory_messages(user_id,project_id,source_id,message_id,content_hash,role,occurred_at,processed)
VALUES ('00000000-0000-4000-8000-000000000002','migration-fixture','dialog','m1',repeat('a',64),'user','2024-01-01T12:00:00.123456Z',true);
INSERT INTO memory_blobs(id,user_id,project_id,source_id,message_ids,status)
VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','migration-fixture','dialog','["m1"]','active');
INSERT INTO memory_facts(id,user_id,project_id,blob_id,content,subject,reporter,certainty,support_groups,occurred_at,search_text,embedding)
VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','migration-fixture','00000000-0000-4000-8000-000000000003','The user reads books.','user','user','asserted','[["m1"]]','2024-01-01T12:00:00.123456Z','The user reads books.',(ARRAY[1::real]||array_fill(0::real,ARRAY[1535]))::vector);
INSERT INTO memory_user_tombstones(user_id,project_id) VALUES ('00000000-0000-4000-8000-000000000005','migration-fixture');
COMMIT;
