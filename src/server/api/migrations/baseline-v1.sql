
CREATE TABLE billings (
	usage_left INTEGER,
	next_refill_at TIMESTAMP WITH TIME ZONE,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id)
)

;


CREATE TABLE projects (
	project_id VARCHAR(64) NOT NULL,
	project_secret VARCHAR(255) NOT NULL,
	profile_config TEXT,
	status VARCHAR(16) NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (project_id),
	UNIQUE (project_id)
)

;
CREATE INDEX idx_projects_project_id ON projects (project_id);

CREATE TABLE project_billings (
	project_id VARCHAR(64) NOT NULL,
	billing_id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (project_id, billing_id),
	FOREIGN KEY(project_id) REFERENCES projects (project_id) ON DELETE CASCADE ON UPDATE CASCADE,
	FOREIGN KEY(billing_id) REFERENCES billings (id) ON DELETE CASCADE ON UPDATE CASCADE
)

;
CREATE INDEX idx_project_billings_billing_id ON project_billings (billing_id);
CREATE INDEX idx_project_billings_project_id ON project_billings (project_id);

CREATE TABLE users (
	additional_fields JSONB,
	project_id VARCHAR(64) NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id, project_id),
	FOREIGN KEY(project_id) REFERENCES projects (project_id) ON DELETE CASCADE ON UPDATE CASCADE
)

;
CREATE INDEX idx_users_id_project_id ON users (id, project_id);

CREATE TABLE general_blobs (
	user_id UUID NOT NULL,
	blob_type VARCHAR(16) NOT NULL,
	blob_data JSONB NOT NULL,
	project_id VARCHAR(64) NOT NULL,
	additional_fields JSONB,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id, project_id),
	FOREIGN KEY(user_id, project_id) REFERENCES users (id, project_id) ON DELETE CASCADE ON UPDATE CASCADE
)

;
CREATE UNIQUE INDEX idx_general_blobs_id_project_id ON general_blobs (id, project_id);
CREATE INDEX idx_general_blobs_user_id_blob_type ON general_blobs (user_id, project_id, blob_type);
CREATE INDEX idx_general_blobs_user_id_id ON general_blobs (user_id, project_id, id);
CREATE INDEX idx_general_blobs_user_id_project_id ON general_blobs (user_id, project_id);

CREATE TABLE user_events (
	event_data JSONB NOT NULL,
	user_id UUID NOT NULL,
	project_id VARCHAR(64) NOT NULL,
	embedding VECTOR(__EMBEDDING_DIM__),
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id, project_id),
	FOREIGN KEY(user_id, project_id) REFERENCES users (id, project_id) ON DELETE CASCADE ON UPDATE CASCADE
)

;
CREATE INDEX idx_user_events_user_id_id_project_id ON user_events (user_id, project_id, id);
CREATE INDEX idx_user_events_user_id_project_id ON user_events (user_id, project_id);

CREATE TABLE user_profiles (
	content TEXT NOT NULL,
	user_id UUID NOT NULL,
	attributes JSONB,
	project_id VARCHAR(64) NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id, project_id),
	FOREIGN KEY(user_id, project_id) REFERENCES users (id, project_id) ON DELETE CASCADE ON UPDATE CASCADE
)

;
CREATE INDEX idx_user_profiles_user_id_id_project_id ON user_profiles (user_id, project_id, id);
CREATE INDEX idx_user_profiles_user_id_project_id ON user_profiles (user_id, project_id);

CREATE TABLE user_statuses (
	type VARCHAR(32) NOT NULL,
	attributes JSONB NOT NULL,
	user_id UUID NOT NULL,
	project_id VARCHAR(64) NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id, project_id),
	FOREIGN KEY(user_id, project_id) REFERENCES users (id, project_id) ON DELETE CASCADE ON UPDATE CASCADE
)

;
CREATE INDEX idx_user_statuses_user_id_id_project_id ON user_statuses (user_id, project_id, id);
CREATE INDEX idx_user_statuses_user_id_project_id ON user_statuses (user_id, project_id);
CREATE INDEX idx_user_statuses_user_id_project_id_type ON user_statuses (user_id, project_id, type);

CREATE TABLE buffer_zones (
	blob_type VARCHAR(16) NOT NULL,
	token_size INTEGER NOT NULL,
	user_id UUID NOT NULL,
	blob_id UUID NOT NULL,
	status VARCHAR(16) NOT NULL,
	project_id VARCHAR(64) NOT NULL,
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id, project_id),
	FOREIGN KEY(user_id, project_id) REFERENCES users (id, project_id) ON DELETE CASCADE ON UPDATE CASCADE,
	FOREIGN KEY(blob_id, project_id) REFERENCES general_blobs (id, project_id) ON DELETE CASCADE ON UPDATE CASCADE
)

;
CREATE INDEX idx_buffer_zones_user_id_blob_type ON buffer_zones (user_id, project_id, blob_type, status);

CREATE TABLE user_event_gists (
	gist_data JSONB NOT NULL,
	event_id UUID NOT NULL,
	user_id UUID NOT NULL,
	project_id VARCHAR(64) NOT NULL,
	embedding VECTOR(__EMBEDDING_DIM__),
	id UUID NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id, project_id),
	FOREIGN KEY(user_id, project_id) REFERENCES users (id, project_id) ON DELETE CASCADE ON UPDATE CASCADE,
	FOREIGN KEY(event_id, project_id) REFERENCES user_events (id, project_id) ON DELETE CASCADE ON UPDATE CASCADE
)

;
CREATE INDEX idx_user_event_gists_user_id_id_project_id ON user_event_gists (user_id, project_id, event_id);
CREATE INDEX idx_user_event_gists_user_id_project_id ON user_event_gists (user_id, project_id);
CREATE INDEX idx_user_event_gists_user_id_project_id_id ON user_event_gists (user_id, project_id, id);
