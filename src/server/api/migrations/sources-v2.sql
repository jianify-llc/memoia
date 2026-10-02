
CREATE TABLE memory_user_states (
	user_id UUID NOT NULL,
	project_id VARCHAR(64) NOT NULL,
	generation BIGINT DEFAULT '0' NOT NULL,
	version BIGINT DEFAULT '0' NOT NULL,
	FOREIGN KEY(user_id, project_id) REFERENCES users (id, project_id) ON DELETE CASCADE,
	UNIQUE (user_id, project_id)
)

;


CREATE TABLE memory_sources (
	id UUID NOT NULL,
	user_id UUID NOT NULL,
	project_id VARCHAR(64) NOT NULL,
	external_id VARCHAR(255) NOT NULL,
	payload JSONB NOT NULL,
	request_hash VARCHAR(64) NOT NULL,
	status VARCHAR(16) NOT NULL,
	retracted_message_ids JSONB DEFAULT '[]' NOT NULL,
	event_id UUID,
	event_deleted BOOLEAN DEFAULT 'false' NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(user_id, project_id) REFERENCES users (id, project_id) ON DELETE CASCADE,
	UNIQUE (user_id, project_id, external_id)
)

;
CREATE INDEX idx_memory_sources_user ON memory_sources (user_id, project_id, created_at, id);

CREATE TABLE memory_operations (
	id UUID NOT NULL,
	user_id UUID NOT NULL,
	project_id VARCHAR(64) NOT NULL,
	idempotency_key VARCHAR(255) NOT NULL,
	kind VARCHAR(16) NOT NULL,
	request_hash VARCHAR(64) NOT NULL,
	request JSONB NOT NULL,
	external_id VARCHAR(255) NOT NULL,
	source_id UUID,
	status VARCHAR(16) NOT NULL,
	result JSONB,
	error JSONB,
	generation BIGINT,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(user_id, project_id) REFERENCES users (id, project_id) ON DELETE CASCADE,
	UNIQUE (user_id, project_id, idempotency_key)
)

;
CREATE INDEX idx_memory_operations_user ON memory_operations (user_id, project_id, created_at, id);

CREATE TABLE memory_facts (
	id UUID NOT NULL,
	user_id UUID NOT NULL,
	project_id VARCHAR(64) NOT NULL,
	source_id UUID NOT NULL,
	content VARCHAR NOT NULL,
	topic VARCHAR(128) NOT NULL,
	sub_topic VARCHAR(128) NOT NULL,
	support_groups JSONB NOT NULL,
	occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
	included BOOLEAN DEFAULT 'true' NOT NULL,
	PRIMARY KEY (id),
	FOREIGN KEY(user_id, project_id) REFERENCES users (id, project_id) ON DELETE CASCADE,
	FOREIGN KEY(source_id) REFERENCES memory_sources (id) ON DELETE CASCADE
)

;
CREATE INDEX idx_memory_facts_user ON memory_facts (user_id, project_id, source_id);
