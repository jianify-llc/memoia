export interface paths {
    "/api/users/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get User */
        get: operations["getUser"];
        put?: never;
        post?: never;
        /** Forget User */
        delete: operations["forgetUser"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/blobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Import Source */
        post: operations["importBlob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/operations/by-key/{idempotency_key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Operation By Key */
        get: operations["getOperationByKey"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Operations */
        get: operations["listOperations"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/operations/{operation_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Operation */
        get: operations["getOperation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/sources": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Sources */
        get: operations["listSources"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/operations/{operation_id}/retry": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Retry Operation */
        post: operations["retryOperation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/blobs/{blob_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Blob */
        get: operations["getBlob"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/sources/{source_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Source */
        get: operations["getSource"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/sources/{source_id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Messages */
        delete: operations["deleteMessages"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/profiles": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Profiles */
        get: operations["getProfiles"];
        put?: never;
        /** Add Profile */
        post: operations["addProfile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Search */
        post: operations["search"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/history": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** History */
        get: operations["getHistory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/projects": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Projects */
        get: operations["listProjects"];
        put?: never;
        /** Create Project */
        post: operations["createProject"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/projects/{project_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update Project */
        patch: operations["updateProject"];
        trace?: never;
    };
    "/api/projects/{project_id}/keys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Keys */
        get: operations["listKeys"];
        put?: never;
        /** Create Key */
        post: operations["createKey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/projects/{project_id}/keys/{key_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Revoke Key */
        delete: operations["revokeKey"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/projects/{project_id}/legacy-token/rotate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Rotate Legacy Token */
        post: operations["rotateLegacyToken"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/healthcheck": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Healthcheck */
        get: operations["healthcheck"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Users */
        get: operations["listUsers"];
        put?: never;
        /** Create User */
        post: operations["createUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/profiles/{profile_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Profile */
        delete: operations["deleteProfile"];
        options?: never;
        head?: never;
        /** Update Profile */
        patch: operations["updateProfile"];
        trace?: never;
    };
    "/api/users/{user_id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Events */
        get: operations["getEvents"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/events/{event_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Event */
        delete: operations["deleteEvent"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/users/{user_id}/context": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Context */
        post: operations["getContext"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/project/config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Config */
        get: operations["getConfig"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /** Update Config */
        patch: operations["updateConfig"];
        trace?: never;
    };
    "/api/project/usage": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Usage */
        get: operations["getUsage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** Blob */
        Blob: {
            /**
             * Blob Id
             * Format: uuid
             */
            blob_id: string;
            /** Source Id */
            source_id: string;
            /**
             * Status
             * @enum {string}
             */
            status: "processing" | "failed" | "active" | "retracted" | "rebuilding";
            /** Message Ids */
            message_ids: string[];
            /** Event Ids */
            event_ids: string[];
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
        };
        /** Context */
        Context: {
            /** Context */
            context: string;
            /** Entries */
            entries: string[];
        };
        /** ContextInput */
        ContextInput: {
            /** Query */
            query?: string | null;
            /**
             * Max Token Size
             * @default 500
             */
            max_token_size: number;
        };
        /** DailyUsage */
        DailyUsage: {
            /**
             * Date
             * @description The date
             */
            date: string;
            /**
             * Total Insert
             * @description The total insert
             * @default 0
             */
            total_insert: number;
            /**
             * Total Success Insert
             * @description The total update
             * @default 0
             */
            total_success_insert: number;
            /**
             * Total Input Token
             * @description The total input token
             * @default 0
             */
            total_input_token: number;
            /**
             * Total Output Token
             * @description The total output token
             * @default 0
             */
            total_output_token: number;
        };
        /** DeleteMessages */
        DeleteMessages: {
            /** Idempotency Key */
            idempotency_key: string;
            /** Message Ids */
            message_ids: string[];
        };
        /** EventData */
        EventData: {
            /** Source Id */
            source_id?: string | null;
            /** Blob Id */
            blob_id?: string | null;
            /** Evidence */
            evidence?: components["schemas"]["Evidence"][];
            /**
             * Profile Delta
             * @description List of profile data
             */
            profile_delta?: components["schemas"]["ProfileDelta"][] | null;
            /**
             * Event Tip
             * @description Event tip
             */
            event_tip?: string | null;
            /**
             * Event Tags
             * @description List of event tags
             */
            event_tags?: components["schemas"]["EventTag"][] | null;
        };
        /** EventRecord */
        EventRecord: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            event_data: components["schemas"]["EventData"];
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** EventTag */
        EventTag: {
            /**
             * Tag
             * @description The event tag
             */
            tag: string;
            /**
             * Value
             * @description The event tag value
             */
            value: string;
        };
        /** EventTime */
        EventTime: {
            /** Start */
            start: string | null;
            /** End */
            end: string | null;
            /**
             * Precision
             * @enum {string}
             */
            precision: "year" | "month" | "day" | "range" | "unknown";
            /** Evidence */
            evidence: components["schemas"]["TimeEvidence"][];
        };
        /** Events */
        Events: {
            /** Events */
            events: components["schemas"]["EventRecord"][];
        };
        /** Evidence */
        Evidence: {
            /**
             * Fact Id
             * Format: uuid
             */
            fact_id: string;
            /**
             * Blob Id
             * Format: uuid
             */
            blob_id: string;
            /** Content */
            content: string;
            /** Topic */
            topic: string;
            /** Sub Topic */
            sub_topic: string;
            /** Support Groups */
            support_groups: string[][];
            event_time?: components["schemas"]["EventTime"] | null;
            /** Source Messages */
            source_messages?: components["schemas"]["SourceObservation"][];
        };
        /** ForgottenUser */
        ForgottenUser: {
            /**
             * User Id
             * Format: uuid
             */
            user_id: string;
            /**
             * Forgotten
             * @constant
             */
            forgotten: true;
        };
        /** HTTPValidationError */
        HTTPValidationError: {
            /** Detail */
            detail?: components["schemas"]["ValidationError"][];
        };
        /** Health */
        Health: {
            /**
             * Status
             * @default ok
             */
            status: string;
        };
        /** HistoricalProfile */
        HistoricalProfile: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Content */
            content: string;
            /** Topic */
            topic: string;
            /** Sub Topic */
            sub_topic: string;
            /** Source Ids */
            source_ids: string[];
            /** Fact Ids */
            fact_ids: string[];
        };
        /** History */
        History: {
            /** Entries */
            entries: components["schemas"]["HistoryEntry"][];
        };
        /** HistoryEntry */
        HistoryEntry: {
            /**
             * Revision Id
             * Format: uuid
             */
            revision_id: string;
            /**
             * Operation Id
             * Format: uuid
             */
            operation_id: string;
            /** Source Id */
            source_id: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Profiles */
            profiles: components["schemas"]["HistoricalProfile"][];
            /** Added */
            added: components["schemas"]["HistoricalProfile"][];
            /** Removed */
            removed: components["schemas"]["HistoricalProfile"][];
        };
        /** IdData */
        IdData: {
            /**
             * Id
             * @description The UUID identifier
             */
            id: string;
        };
        /** ImportSource */
        ImportSource: {
            /** Idempotency Key */
            idempotency_key: string;
            /** Source Id */
            source_id: string;
            /** Messages */
            messages: components["schemas"]["SourceMessage"][];
            /** Metadata */
            metadata?: {
                [key: string]: unknown;
            };
        };
        /** IssuedKey */
        IssuedKey: {
            /**
             * Key Id
             * Format: uuid
             */
            key_id: string;
            /** Name */
            name: string;
            /** Scopes */
            scopes: ("read" | "write" | "admin")[];
            /** Expires At */
            expires_at: string | null;
            /** Revoked At */
            revoked_at: string | null;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Token */
            token: string;
        };
        /** KeyCreate */
        KeyCreate: {
            /** Name */
            name: string;
            /** Scopes */
            scopes: ("read" | "write" | "admin")[];
            /** Expires At */
            expires_at?: string | null;
        };
        /** Keys */
        Keys: {
            /** Keys */
            keys: components["schemas"]["ManagedKey"][];
        };
        /** LegacyToken */
        LegacyToken: {
            /** Token */
            token: string;
        };
        /** ManagedKey */
        ManagedKey: {
            /**
             * Key Id
             * Format: uuid
             */
            key_id: string;
            /** Name */
            name: string;
            /** Scopes */
            scopes: ("read" | "write" | "admin")[];
            /** Expires At */
            expires_at: string | null;
            /** Revoked At */
            revoked_at: string | null;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
        };
        /** ManagedProject */
        ManagedProject: {
            /** Project Id */
            project_id: string;
            /** Status */
            status: string;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
        };
        /** Operation */
        Operation: {
            /**
             * Operation Id
             * Format: uuid
             */
            operation_id: string;
            /**
             * Status
             * @enum {string}
             */
            status: "processing" | "completed" | "failed";
            /** Source Id */
            source_id: string;
            /** Blob Id */
            blob_id: string | null;
            result: components["schemas"]["SourceResult"] | null;
            error: components["schemas"]["OperationError"] | null;
        };
        /** OperationError */
        OperationError: {
            /** Code */
            code: string;
            /** Retryable */
            retryable: boolean;
        };
        /** Operations */
        Operations: {
            /** Operations */
            operations: components["schemas"]["Operation"][];
        };
        /** Profile */
        Profile: {
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Content */
            content: string;
            /** Topic */
            topic: string;
            /** Sub Topic */
            sub_topic: string;
            /** Source Ids */
            source_ids: string[];
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
        };
        /** ProfileConfig */
        ProfileConfig: {
            /** Profile Config */
            profile_config: string;
        };
        /** ProfileDelta */
        ProfileDelta: {
            /**
             * Content
             * @description The profile content
             */
            content: string;
            /**
             * Attributes
             * @description User profile attributes in JSON, containing 'topic', 'sub_topic'
             */
            attributes: {
                [key: string]: unknown;
            } | null;
        };
        /** ProfileInput */
        ProfileInput: {
            /** Content */
            content: string;
            /** Topic */
            topic: string;
            /** Sub Topic */
            sub_topic: string;
        };
        /** Profiles */
        Profiles: {
            /** Profiles */
            profiles: components["schemas"]["Profile"][];
        };
        /** ProjectCreate */
        ProjectCreate: {
            /** Project Id */
            project_id: string;
        };
        /** ProjectUpdate */
        ProjectUpdate: {
            /**
             * Status
             * @enum {string}
             */
            status: "active" | "suspended";
        };
        /** ProjectUser */
        ProjectUser: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Project Id */
            project_id: string;
            /** Additional Fields */
            additional_fields: {
                [key: string]: unknown;
            } | null;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /**
             * Updated At
             * Format: date-time
             */
            updated_at: string;
            /** Profile Count */
            profile_count: number;
            /** Event Count */
            event_count: number;
        };
        /** Projects */
        Projects: {
            /** Projects */
            projects: components["schemas"]["ManagedProject"][];
        };
        /** SearchEvent */
        SearchEvent: {
            /**
             * Id
             * Format: uuid
             */
            id: string;
            /** Content */
            content: string;
            /** Source Id */
            source_id: string | null;
            /** Blob Id */
            blob_id: string | null;
            /** Score */
            score: number;
            /**
             * Occurred At
             * Format: date-time
             */
            occurred_at: string;
            /** Evidence */
            evidence?: components["schemas"]["Evidence"][];
        };
        /** SearchInput */
        SearchInput: {
            /** Query */
            query: string;
            /**
             * Limit
             * @default 10
             */
            limit: number;
        };
        /** SearchResult */
        SearchResult: {
            /** Events */
            events: components["schemas"]["SearchEvent"][];
        };
        /** Source */
        Source: {
            /** Source Id */
            source_id: string;
            /** Legacy */
            legacy: boolean;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
            /** Message Ids */
            message_ids: string[];
            /** Deleted Message Ids */
            deleted_message_ids: string[];
            /** Blobs */
            blobs: components["schemas"]["Blob"][];
            /** Evidence */
            evidence: components["schemas"]["Evidence"][];
            /** Next Message Offset */
            next_message_offset: number | null;
            /** Next Blob Offset */
            next_blob_offset: number | null;
            /** Next Evidence Offset */
            next_evidence_offset: number | null;
        };
        /** SourceMessage */
        SourceMessage: {
            /** Message Id */
            message_id: string;
            /**
             * Role
             * @enum {string}
             */
            role: "user" | "assistant" | "system" | "tool";
            /** Content */
            content: string;
            /**
             * Occurred At
             * Format: date-time
             */
            occurred_at: string;
            /** Time Zone */
            time_zone?: string | null;
        };
        /** SourceObservation */
        SourceObservation: {
            /** Message Id */
            message_id: string;
            /**
             * Recorded At
             * Format: date-time
             */
            recorded_at: string;
            /** Time Zone */
            time_zone?: string | null;
        };
        /** SourceResult */
        SourceResult: {
            /** Event Ids */
            event_ids: string[];
            /** Profile Ids */
            profile_ids: string[];
        };
        /** SourceSummary */
        SourceSummary: {
            /** Source Id */
            source_id: string;
            /** Legacy */
            legacy: boolean;
            /**
             * Created At
             * Format: date-time
             */
            created_at: string;
        };
        /** Sources */
        Sources: {
            /** Sources */
            sources: components["schemas"]["SourceSummary"][];
        };
        /** TimeEvidence */
        TimeEvidence: {
            /** Message Id */
            message_id: string;
            /** Expression */
            expression: string;
        };
        /** Usage */
        Usage: {
            /** Usages */
            usages: components["schemas"]["DailyUsage"][];
        };
        /** UserData */
        UserData: {
            /**
             * Data
             * @description User additional data in JSON
             */
            data?: {
                [key: string]: unknown;
            } | null;
            /**
             * Id
             * @description User ID in UUIDv4/5
             */
            id?: string | null;
            /**
             * Created At
             * @description Timestamp when the user was created
             */
            created_at?: string | null;
            /**
             * Updated At
             * @description Timestamp when the user was last updated
             */
            updated_at?: string | null;
        };
        /** Users */
        Users: {
            /** Users */
            users: components["schemas"]["ProjectUser"][];
            /** Count */
            count: number;
        };
        /** ValidationError */
        ValidationError: {
            /** Location */
            loc: (string | number)[];
            /** Message */
            msg: string;
            /** Error Type */
            type: string;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    getUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserData"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    forgetUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ForgottenUser"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    importBlob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ImportSource"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    getOperationByKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
                idempotency_key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    listOperations: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operations"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    getOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
                operation_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    listSources: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Sources"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    retryOperation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
                operation_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    getBlob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
                blob_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Blob"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    getSource: {
        parameters: {
            query?: {
                limit?: number;
                message_offset?: number;
                blob_offset?: number;
                evidence_offset?: number;
            };
            header?: never;
            path: {
                user_id: string;
                source_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Source"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    deleteMessages: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
                source_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeleteMessages"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Operation"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    getProfiles: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Profiles"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    addProfile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProfileInput"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IdData"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    search: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SearchInput"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SearchResult"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    getHistory: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["History"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    listProjects: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Projects"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    createProject: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ManagedProject"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    updateProject: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProjectUpdate"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ManagedProject"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    listKeys: {
        parameters: {
            query?: {
                limit?: number;
                offset?: number;
            };
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Keys"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    createKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["KeyCreate"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IssuedKey"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    revokeKey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
                key_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    rotateLegacyToken: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                project_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LegacyToken"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    healthcheck: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Health"];
                };
            };
        };
    };
    listUsers: {
        parameters: {
            query?: {
                search?: string;
                order_by?: "updated_at" | "profile_count" | "event_count";
                order_desc?: boolean;
                limit?: number;
                offset?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Users"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    createUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UserData"];
            };
        };
        responses: {
            /** @description Successful Response */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["IdData"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    deleteProfile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
                profile_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    updateProfile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
                profile_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProfileInput"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    getEvents: {
        parameters: {
            query?: {
                limit?: number;
                time_range_in_days?: number;
            };
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Events"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    deleteEvent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
                event_id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    getContext: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ContextInput"];
            };
        };
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Context"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    getConfig: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProfileConfig"];
                };
            };
        };
    };
    updateConfig: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ProfileConfig"];
            };
        };
        responses: {
            /** @description Successful Response */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
    getUsage: {
        parameters: {
            query?: {
                last_days?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Successful Response */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Usage"];
                };
            };
            /** @description Validation Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["HTTPValidationError"];
                };
            };
        };
    };
}
