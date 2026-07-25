export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      addon_modules: {
        Row: {
          billing_period: string
          category: string
          created_at: string
          currency: string
          description: string | null
          id: string
          included_in_plans: string[]
          is_active: boolean
          metadata: Json
          name: string
          price_max_cents: number
          price_min_cents: number
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          billing_period?: string
          category?: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          included_in_plans?: string[]
          is_active?: boolean
          metadata?: Json
          name: string
          price_max_cents?: number
          price_min_cents?: number
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          billing_period?: string
          category?: string
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          included_in_plans?: string[]
          is_active?: boolean
          metadata?: Json
          name?: string
          price_max_cents?: number
          price_min_cents?: number
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      ai_usage_log: {
        Row: {
          completion_tokens: number | null
          cost_estimate_usd: number | null
          created_at: string
          feature: string
          id: string
          metadata: Json
          model: string
          prompt_tokens: number | null
          total_tokens: number | null
          user_id: string | null
        }
        Insert: {
          completion_tokens?: number | null
          cost_estimate_usd?: number | null
          created_at?: string
          feature: string
          id?: string
          metadata?: Json
          model: string
          prompt_tokens?: number | null
          total_tokens?: number | null
          user_id?: string | null
        }
        Update: {
          completion_tokens?: number | null
          cost_estimate_usd?: number | null
          created_at?: string
          feature?: string
          id?: string
          metadata?: Json
          model?: string
          prompt_tokens?: number | null
          total_tokens?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string | null
          id: string
          metadata: Json
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          metadata?: Json
        }
        Relationships: []
      }
      billing_handoffs: {
        Row: {
          clone_id: string | null
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          intent: string | null
          origin_source: string
          origin_user_id: string
          origin_username: string | null
          return_url: string | null
          tenant_id: string | null
        }
        Insert: {
          clone_id?: string | null
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          intent?: string | null
          origin_source: string
          origin_user_id: string
          origin_username?: string | null
          return_url?: string | null
          tenant_id?: string | null
        }
        Update: {
          clone_id?: string | null
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          intent?: string | null
          origin_source?: string
          origin_user_id?: string
          origin_username?: string | null
          return_url?: string | null
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "billing_handoffs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_handoffs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "billing_handoffs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_plans: {
        Row: {
          created_at: string
          currency: string
          id: string
          is_active: boolean
          metadata: Json
          monthly_allowance: number
          name: string
          overage_policy: Database["public"]["Enums"]["overage_policy"]
          price_cents: number
          rollover_cap: number
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          metadata?: Json
          monthly_allowance?: number
          name: string
          overage_policy?: Database["public"]["Enums"]["overage_policy"]
          price_cents?: number
          rollover_cap?: number
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          metadata?: Json
          monthly_allowance?: number
          name?: string
          overage_policy?: Database["public"]["Enums"]["overage_policy"]
          price_cents?: number
          rollover_cap?: number
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      cascade_approvals: {
        Row: {
          approver_user_id: string
          cascade_event_id: string
          created_at: string
          decision: string
          id: string
          reason: string | null
        }
        Insert: {
          approver_user_id: string
          cascade_event_id: string
          created_at?: string
          decision: string
          id?: string
          reason?: string | null
        }
        Update: {
          approver_user_id?: string
          cascade_event_id?: string
          created_at?: string
          decision?: string
          id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cascade_approvals_cascade_event_id_fkey"
            columns: ["cascade_event_id"]
            isOneToOne: false
            referencedRelation: "cascade_events"
            referencedColumns: ["id"]
          },
        ]
      }
      cascade_events: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          initiated_by: string | null
          mode: Database["public"]["Enums"]["cascade_mode"]
          requires_approval: boolean
          scope_filter: Json
          source_branch: string | null
          source_sha: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["cascade_event_status"]
          summary: string | null
          trigger: Database["public"]["Enums"]["cascade_trigger"]
          updated_at: string
          worker_finished_at: string | null
          worker_started_at: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          initiated_by?: string | null
          mode: Database["public"]["Enums"]["cascade_mode"]
          requires_approval?: boolean
          scope_filter?: Json
          source_branch?: string | null
          source_sha?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["cascade_event_status"]
          summary?: string | null
          trigger: Database["public"]["Enums"]["cascade_trigger"]
          updated_at?: string
          worker_finished_at?: string | null
          worker_started_at?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          initiated_by?: string | null
          mode?: Database["public"]["Enums"]["cascade_mode"]
          requires_approval?: boolean
          scope_filter?: Json
          source_branch?: string | null
          source_sha?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["cascade_event_status"]
          summary?: string | null
          trigger?: Database["public"]["Enums"]["cascade_trigger"]
          updated_at?: string
          worker_finished_at?: string | null
          worker_started_at?: string | null
        }
        Relationships: []
      }
      cascade_results: {
        Row: {
          cascade_event_id: string
          clone_id: string
          commit_sha: string | null
          completed_at: string | null
          created_at: string
          diff_summary: string | null
          error_message: string | null
          files_changed: number
          id: string
          pr_url: string | null
          previous_sha: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["cascade_result_status"]
          updated_at: string
        }
        Insert: {
          cascade_event_id: string
          clone_id: string
          commit_sha?: string | null
          completed_at?: string | null
          created_at?: string
          diff_summary?: string | null
          error_message?: string | null
          files_changed?: number
          id?: string
          pr_url?: string | null
          previous_sha?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["cascade_result_status"]
          updated_at?: string
        }
        Update: {
          cascade_event_id?: string
          clone_id?: string
          commit_sha?: string | null
          completed_at?: string | null
          created_at?: string
          diff_summary?: string | null
          error_message?: string | null
          files_changed?: number
          id?: string
          pr_url?: string | null
          previous_sha?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["cascade_result_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cascade_results_cascade_event_id_fkey"
            columns: ["cascade_event_id"]
            isOneToOne: false
            referencedRelation: "cascade_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cascade_results_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cascade_results_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      cascade_schedules: {
        Row: {
          created_at: string
          created_by: string | null
          cron_expression: string
          enabled: boolean
          id: string
          kind: Database["public"]["Enums"]["cascade_schedule_kind"]
          last_cascade_event_id: string | null
          last_run_at: string | null
          mode: Database["public"]["Enums"]["cascade_mode"]
          name: string
          next_run_at: string | null
          notes: string | null
          scope_filter: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          cron_expression: string
          enabled?: boolean
          id?: string
          kind: Database["public"]["Enums"]["cascade_schedule_kind"]
          last_cascade_event_id?: string | null
          last_run_at?: string | null
          mode?: Database["public"]["Enums"]["cascade_mode"]
          name: string
          next_run_at?: string | null
          notes?: string | null
          scope_filter?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          cron_expression?: string
          enabled?: boolean
          id?: string
          kind?: Database["public"]["Enums"]["cascade_schedule_kind"]
          last_cascade_event_id?: string | null
          last_run_at?: string | null
          mode?: Database["public"]["Enums"]["cascade_mode"]
          name?: string
          next_run_at?: string | null
          notes?: string | null
          scope_filter?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cascade_schedules_last_cascade_event_id_fkey"
            columns: ["last_cascade_event_id"]
            isOneToOne: false
            referencedRelation: "cascade_events"
            referencedColumns: ["id"]
          },
        ]
      }
      cascade_templates: {
        Row: {
          clone_ids: string[]
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          last_used_at: string | null
          mode: Database["public"]["Enums"]["cascade_mode"]
          name: string
          scope: string
          tags: string[]
          updated_at: string
          use_count: number
        }
        Insert: {
          clone_ids?: string[]
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          last_used_at?: string | null
          mode?: Database["public"]["Enums"]["cascade_mode"]
          name: string
          scope?: string
          tags?: string[]
          updated_at?: string
          use_count?: number
        }
        Update: {
          clone_ids?: string[]
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          last_used_at?: string | null
          mode?: Database["public"]["Enums"]["cascade_mode"]
          name?: string
          scope?: string
          tags?: string[]
          updated_at?: string
          use_count?: number
        }
        Relationships: []
      }
      client_supabase_accounts: {
        Row: {
          clone_id: string | null
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          org_id: string | null
          org_slug: string | null
          owner_email: string
          owner_name: string | null
          pat_ciphertext: string | null
          pat_last4: string | null
          pat_nonce: string | null
          plan_tier: string | null
          region_allowed: string[]
          revoked_at: string | null
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          org_id?: string | null
          org_slug?: string | null
          owner_email: string
          owner_name?: string | null
          pat_ciphertext?: string | null
          pat_last4?: string | null
          pat_nonce?: string | null
          plan_tier?: string | null
          region_allowed?: string[]
          revoked_at?: string | null
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          org_id?: string | null
          org_slug?: string | null
          owner_email?: string
          owner_name?: string | null
          pat_ciphertext?: string | null
          pat_last4?: string | null
          pat_nonce?: string | null
          plan_tier?: string | null
          region_allowed?: string[]
          revoked_at?: string | null
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_supabase_accounts_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_supabase_accounts_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_api_keys: {
        Row: {
          clone_id: string | null
          created_at: string
          created_by: string | null
          first_used_at: string | null
          id: string
          key_hash: string
          key_prefix: string
          label: string
          last_used_at: string | null
          revoke_at: string | null
          revoked_at: string | null
          rotated_from: string | null
          rotated_to: string | null
          scopes: string[]
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          first_used_at?: string | null
          id?: string
          key_hash: string
          key_prefix: string
          label: string
          last_used_at?: string | null
          revoke_at?: string | null
          revoked_at?: string | null
          rotated_from?: string | null
          rotated_to?: string | null
          scopes?: string[]
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          first_used_at?: string | null
          id?: string
          key_hash?: string
          key_prefix?: string
          label?: string
          last_used_at?: string | null
          revoke_at?: string | null
          revoked_at?: string | null
          rotated_from?: string | null
          rotated_to?: string | null
          scopes?: string[]
        }
        Relationships: [
          {
            foreignKeyName: "clone_api_keys_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_api_keys_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_api_keys_rotated_from_fkey"
            columns: ["rotated_from"]
            isOneToOne: false
            referencedRelation: "clone_api_keys"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_api_keys_rotated_to_fkey"
            columns: ["rotated_to"]
            isOneToOne: false
            referencedRelation: "clone_api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_backend_secrets: {
        Row: {
          clone_id: string
          created_at: string
          id: string
          last_error: string | null
          last_set_at: string | null
          name: string
          set_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          id?: string
          last_error?: string | null
          last_set_at?: string | null
          name: string
          set_by?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          id?: string
          last_error?: string | null
          last_set_at?: string | null
          name?: string
          set_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_backend_secrets_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_backend_secrets_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_backends: {
        Row: {
          admin_email: string | null
          anon_key: string | null
          attempts: number
          clone_id: string
          created_at: string
          db_pass: string | null
          edge_functions: Json
          enqueued_by: string | null
          error_message: string | null
          id: string
          migration_version: string | null
          migrations_applied: Json
          queued_admin_password_enc: string | null
          queued_at: string | null
          queued_module_ids: string[] | null
          region: string
          secret_shells: Json
          service_role_key: string | null
          source_ref: string | null
          source_repo: string | null
          source_sha: string | null
          status: Database["public"]["Enums"]["clone_backend_status"]
          status_detail: string | null
          supabase_project_ref: string | null
          supabase_url: string | null
          updated_at: string
          worker_finished_at: string | null
          worker_started_at: string | null
        }
        Insert: {
          admin_email?: string | null
          anon_key?: string | null
          attempts?: number
          clone_id: string
          created_at?: string
          db_pass?: string | null
          edge_functions?: Json
          enqueued_by?: string | null
          error_message?: string | null
          id?: string
          migration_version?: string | null
          migrations_applied?: Json
          queued_admin_password_enc?: string | null
          queued_at?: string | null
          queued_module_ids?: string[] | null
          region?: string
          secret_shells?: Json
          service_role_key?: string | null
          source_ref?: string | null
          source_repo?: string | null
          source_sha?: string | null
          status?: Database["public"]["Enums"]["clone_backend_status"]
          status_detail?: string | null
          supabase_project_ref?: string | null
          supabase_url?: string | null
          updated_at?: string
          worker_finished_at?: string | null
          worker_started_at?: string | null
        }
        Update: {
          admin_email?: string | null
          anon_key?: string | null
          attempts?: number
          clone_id?: string
          created_at?: string
          db_pass?: string | null
          edge_functions?: Json
          enqueued_by?: string | null
          error_message?: string | null
          id?: string
          migration_version?: string | null
          migrations_applied?: Json
          queued_admin_password_enc?: string | null
          queued_at?: string | null
          queued_module_ids?: string[] | null
          region?: string
          secret_shells?: Json
          service_role_key?: string | null
          source_ref?: string | null
          source_repo?: string | null
          source_sha?: string | null
          status?: Database["public"]["Enums"]["clone_backend_status"]
          status_detail?: string | null
          supabase_project_ref?: string | null
          supabase_url?: string | null
          updated_at?: string
          worker_finished_at?: string | null
          worker_started_at?: string | null
        }
        Relationships: []
      }
      clone_brand_asset_variants: {
        Row: {
          byte_size: number | null
          content_type: string
          generated_at: string
          height: number | null
          id: string
          profile_id: string
          public_url: string
          source_path: string
          variant_kind: string
          variant_path: string
          width: number | null
        }
        Insert: {
          byte_size?: number | null
          content_type: string
          generated_at?: string
          height?: number | null
          id?: string
          profile_id: string
          public_url: string
          source_path: string
          variant_kind: string
          variant_path: string
          width?: number | null
        }
        Update: {
          byte_size?: number | null
          content_type?: string
          generated_at?: string
          height?: number | null
          id?: string
          profile_id?: string
          public_url?: string
          source_path?: string
          variant_kind?: string
          variant_path?: string
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_brand_asset_variants_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "clone_brand_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_brand_assignments: {
        Row: {
          applied_at: string | null
          applied_by: string | null
          applied_config_hash: string | null
          clone_id: string
          created_at: string
          drift_summary: string | null
          error_message: string | null
          id: string
          last_drift_check_at: string | null
          override_keys: string[]
          overrides: Json
          profile_id: string
          status: Database["public"]["Enums"]["brand_assignment_status"]
          updated_at: string
        }
        Insert: {
          applied_at?: string | null
          applied_by?: string | null
          applied_config_hash?: string | null
          clone_id: string
          created_at?: string
          drift_summary?: string | null
          error_message?: string | null
          id?: string
          last_drift_check_at?: string | null
          override_keys?: string[]
          overrides?: Json
          profile_id: string
          status?: Database["public"]["Enums"]["brand_assignment_status"]
          updated_at?: string
        }
        Update: {
          applied_at?: string | null
          applied_by?: string | null
          applied_config_hash?: string | null
          clone_id?: string
          created_at?: string
          drift_summary?: string | null
          error_message?: string | null
          id?: string
          last_drift_check_at?: string | null
          override_keys?: string[]
          overrides?: Json
          profile_id?: string
          status?: Database["public"]["Enums"]["brand_assignment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_brand_assignments_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "clone_brand_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_brand_history: {
        Row: {
          cascade_event_id: string | null
          clone_id: string
          config_hash: string | null
          config_snapshot: Json
          created_at: string
          duration_ms: number | null
          error_message: string | null
          id: string
          profile_id: string | null
          profile_version: number | null
          pushed_by: string | null
          status: Database["public"]["Enums"]["brand_assignment_status"]
        }
        Insert: {
          cascade_event_id?: string | null
          clone_id: string
          config_hash?: string | null
          config_snapshot?: Json
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          profile_id?: string | null
          profile_version?: number | null
          pushed_by?: string | null
          status?: Database["public"]["Enums"]["brand_assignment_status"]
        }
        Update: {
          cascade_event_id?: string | null
          clone_id?: string
          config_hash?: string | null
          config_snapshot?: Json
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          profile_id?: string | null
          profile_version?: number | null
          pushed_by?: string | null
          status?: Database["public"]["Enums"]["brand_assignment_status"]
        }
        Relationships: []
      }
      clone_brand_profiles: {
        Row: {
          asset_manifest: Json
          brand_config: Json
          config_hash: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_default: boolean
          name: string
          published_at: string | null
          published_by: string | null
          published_version_id: string | null
          report_contact: Json
          slug: string
          status: Database["public"]["Enums"]["brand_profile_status"]
          tags: string[]
          updated_at: string
          version: number
        }
        Insert: {
          asset_manifest?: Json
          brand_config?: Json
          config_hash?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_default?: boolean
          name: string
          published_at?: string | null
          published_by?: string | null
          published_version_id?: string | null
          report_contact?: Json
          slug: string
          status?: Database["public"]["Enums"]["brand_profile_status"]
          tags?: string[]
          updated_at?: string
          version?: number
        }
        Update: {
          asset_manifest?: Json
          brand_config?: Json
          config_hash?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_default?: boolean
          name?: string
          published_at?: string | null
          published_by?: string | null
          published_version_id?: string | null
          report_contact?: Json
          slug?: string
          status?: Database["public"]["Enums"]["brand_profile_status"]
          tags?: string[]
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "clone_brand_profiles_published_version_id_fkey"
            columns: ["published_version_id"]
            isOneToOne: false
            referencedRelation: "clone_brand_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_brand_versions: {
        Row: {
          asset_manifest: Json
          brand_config: Json
          config_hash: string | null
          created_at: string
          id: string
          notes: string | null
          profile_id: string
          published_at: string
          published_by: string | null
          report_contact: Json
          version: number
        }
        Insert: {
          asset_manifest?: Json
          brand_config?: Json
          config_hash?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          profile_id: string
          published_at?: string
          published_by?: string | null
          report_contact?: Json
          version: number
        }
        Update: {
          asset_manifest?: Json
          brand_config?: Json
          config_hash?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          profile_id?: string
          published_at?: string
          published_by?: string | null
          report_contact?: Json
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "clone_brand_versions_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "clone_brand_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_drift_policies: {
        Row: {
          auto_apply_severity: Database["public"]["Enums"]["drift_severity"]
          cascade_mode: Database["public"]["Enums"]["cascade_mode"]
          clone_id: string
          created_at: string
          enabled: boolean
          id: string
          last_applied_at: string | null
          last_applied_count: number
          max_per_run: number
          muted_kinds: string[]
          updated_at: string
        }
        Insert: {
          auto_apply_severity?: Database["public"]["Enums"]["drift_severity"]
          cascade_mode?: Database["public"]["Enums"]["cascade_mode"]
          clone_id: string
          created_at?: string
          enabled?: boolean
          id?: string
          last_applied_at?: string | null
          last_applied_count?: number
          max_per_run?: number
          muted_kinds?: string[]
          updated_at?: string
        }
        Update: {
          auto_apply_severity?: Database["public"]["Enums"]["drift_severity"]
          cascade_mode?: Database["public"]["Enums"]["cascade_mode"]
          clone_id?: string
          created_at?: string
          enabled?: boolean
          id?: string
          last_applied_at?: string | null
          last_applied_count?: number
          max_per_run?: number
          muted_kinds?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_drift_policies_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_drift_policies_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_edge_config: {
        Row: {
          account_ref: string | null
          bot_fight: boolean
          clone_id: string
          created_at: string
          created_by: string | null
          custom_rules: Json
          drift: Json | null
          external_ref: string | null
          hostname: string | null
          id: string
          last_synced_at: string | null
          posture_preset: string | null
          provider_slug: string
          rate_limit_rps: number | null
          security_level: string | null
          status: string
          status_detail: string | null
          updated_at: string
          waf_preset: string | null
        }
        Insert: {
          account_ref?: string | null
          bot_fight?: boolean
          clone_id: string
          created_at?: string
          created_by?: string | null
          custom_rules?: Json
          drift?: Json | null
          external_ref?: string | null
          hostname?: string | null
          id?: string
          last_synced_at?: string | null
          posture_preset?: string | null
          provider_slug: string
          rate_limit_rps?: number | null
          security_level?: string | null
          status?: string
          status_detail?: string | null
          updated_at?: string
          waf_preset?: string | null
        }
        Update: {
          account_ref?: string | null
          bot_fight?: boolean
          clone_id?: string
          created_at?: string
          created_by?: string | null
          custom_rules?: Json
          drift?: Json | null
          external_ref?: string | null
          hostname?: string | null
          id?: string
          last_synced_at?: string | null
          posture_preset?: string | null
          provider_slug?: string
          rate_limit_rps?: number | null
          security_level?: string | null
          status?: string
          status_detail?: string | null
          updated_at?: string
          waf_preset?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_edge_config_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_edge_config_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_edge_config_posture_preset_fkey"
            columns: ["posture_preset"]
            isOneToOne: false
            referencedRelation: "edge_posture_presets"
            referencedColumns: ["slug"]
          },
          {
            foreignKeyName: "clone_edge_config_provider_slug_fkey"
            columns: ["provider_slug"]
            isOneToOne: false
            referencedRelation: "edge_providers"
            referencedColumns: ["slug"]
          },
        ]
      }
      clone_handoffs: {
        Row: {
          backend_id: string | null
          client_account_id: string | null
          clone_id: string
          completed_at: string | null
          consent_signed_at: string | null
          consent_terms_version: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          initiated_at: string | null
          metadata: Json
          path: Database["public"]["Enums"]["handoff_path"]
          policy_id: string | null
          rollback_snapshot_id: string | null
          state: Database["public"]["Enums"]["handoff_state"]
          target_plan_tier: string | null
          target_project_ref: string | null
          target_project_url: string | null
          target_region: string | null
          updated_at: string
        }
        Insert: {
          backend_id?: string | null
          client_account_id?: string | null
          clone_id: string
          completed_at?: string | null
          consent_signed_at?: string | null
          consent_terms_version?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          initiated_at?: string | null
          metadata?: Json
          path?: Database["public"]["Enums"]["handoff_path"]
          policy_id?: string | null
          rollback_snapshot_id?: string | null
          state?: Database["public"]["Enums"]["handoff_state"]
          target_plan_tier?: string | null
          target_project_ref?: string | null
          target_project_url?: string | null
          target_region?: string | null
          updated_at?: string
        }
        Update: {
          backend_id?: string | null
          client_account_id?: string | null
          clone_id?: string
          completed_at?: string | null
          consent_signed_at?: string | null
          consent_terms_version?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          initiated_at?: string | null
          metadata?: Json
          path?: Database["public"]["Enums"]["handoff_path"]
          policy_id?: string | null
          rollback_snapshot_id?: string | null
          state?: Database["public"]["Enums"]["handoff_state"]
          target_plan_tier?: string | null
          target_project_ref?: string | null
          target_project_url?: string | null
          target_region?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_handoffs_backend_id_fkey"
            columns: ["backend_id"]
            isOneToOne: false
            referencedRelation: "clone_backends"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_handoffs_backend_id_fkey"
            columns: ["backend_id"]
            isOneToOne: false
            referencedRelation: "clone_backends_safe"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_handoffs_client_account_id_fkey"
            columns: ["client_account_id"]
            isOneToOne: false
            referencedRelation: "client_supabase_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_handoffs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_handoffs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_handoffs_policy_id_fkey"
            columns: ["policy_id"]
            isOneToOne: false
            referencedRelation: "handoff_region_plan_policies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_handoffs_rollback_snapshot_fk"
            columns: ["rollback_snapshot_id"]
            isOneToOne: false
            referencedRelation: "handoff_snapshots"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_health_beacons: {
        Row: {
          active_connections: number | null
          api_p95_ms: number | null
          clone_id: string
          created_at: string
          db_size_bytes: number | null
          edge_invocations_24h: number | null
          error_count_24h: number | null
          handoff_id: string | null
          id: string
          message: string | null
          payload: Json
          project_ref: string | null
          project_status: string | null
          reported_at: string
          severity: string | null
          source: string
          storage_used_bytes: number | null
        }
        Insert: {
          active_connections?: number | null
          api_p95_ms?: number | null
          clone_id: string
          created_at?: string
          db_size_bytes?: number | null
          edge_invocations_24h?: number | null
          error_count_24h?: number | null
          handoff_id?: string | null
          id?: string
          message?: string | null
          payload?: Json
          project_ref?: string | null
          project_status?: string | null
          reported_at?: string
          severity?: string | null
          source: string
          storage_used_bytes?: number | null
        }
        Update: {
          active_connections?: number | null
          api_p95_ms?: number | null
          clone_id?: string
          created_at?: string
          db_size_bytes?: number | null
          edge_invocations_24h?: number | null
          error_count_24h?: number | null
          handoff_id?: string | null
          id?: string
          message?: string | null
          payload?: Json
          project_ref?: string | null
          project_status?: string | null
          reported_at?: string
          severity?: string | null
          source?: string
          storage_used_bytes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_health_beacons_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_health_beacons_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_health_beacons_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_health_snapshots: {
        Row: {
          clone_id: string
          created_at: string
          id: string
          payload: Json
          probed_at: string
          updated_at: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          id?: string
          payload: Json
          probed_at?: string
          updated_at?: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          id?: string
          payload?: Json
          probed_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_health_snapshots_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_health_snapshots_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clone_library_pins: {
        Row: {
          clone_id: string
          created_at: string
          id: string
          library_entry_id: string
          notes: string | null
          pinned_at: string
          pinned_by: string | null
          slug: string
          updated_at: string
          version: number
        }
        Insert: {
          clone_id: string
          created_at?: string
          id?: string
          library_entry_id: string
          notes?: string | null
          pinned_at?: string
          pinned_by?: string | null
          slug: string
          updated_at?: string
          version: number
        }
        Update: {
          clone_id?: string
          created_at?: string
          id?: string
          library_entry_id?: string
          notes?: string | null
          pinned_at?: string
          pinned_by?: string | null
          slug?: string
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      clone_modules: {
        Row: {
          clone_id: string
          id: string
          installed_at: string
          installed_by: string | null
          module_id: string
          version: string | null
        }
        Insert: {
          clone_id: string
          id?: string
          installed_at?: string
          installed_by?: string | null
          module_id: string
          version?: string | null
        }
        Update: {
          clone_id?: string
          id?: string
          installed_at?: string
          installed_by?: string | null
          module_id?: string
          version?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_modules_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_modules_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "clone_modules_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_seat_devices: {
        Row: {
          clone_id: string | null
          created_at: string
          device_fingerprint: string
          device_label: string | null
          external_user_id: string
          first_seen_at: string
          id: string
          ip_address: string | null
          last_seen_at: string
          metadata: Json
          platform: string | null
          revoked_at: string | null
          revoked_reason: string | null
          seat_id: string
          status: string
          updated_at: string
          user_agent: string | null
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          device_fingerprint: string
          device_label?: string | null
          external_user_id: string
          first_seen_at?: string
          id?: string
          ip_address?: string | null
          last_seen_at?: string
          metadata?: Json
          platform?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          seat_id: string
          status?: string
          updated_at?: string
          user_agent?: string | null
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          device_fingerprint?: string
          device_label?: string | null
          external_user_id?: string
          first_seen_at?: string
          id?: string
          ip_address?: string | null
          last_seen_at?: string
          metadata?: Json
          platform?: string | null
          revoked_at?: string | null
          revoked_reason?: string | null
          seat_id?: string
          status?: string
          updated_at?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_seat_devices_seat_id_fkey"
            columns: ["seat_id"]
            isOneToOne: false
            referencedRelation: "clone_seats"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_seat_entitlements: {
        Row: {
          canceled_at: string | null
          clone_id: string | null
          created_at: string
          current_period_end: string | null
          expires_at: string | null
          granted_at: string
          id: string
          notes: string | null
          past_due_at: string | null
          seat_plan_id: string
          seats_used: number
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
        }
        Insert: {
          canceled_at?: string | null
          clone_id?: string | null
          created_at?: string
          current_period_end?: string | null
          expires_at?: string | null
          granted_at?: string
          id?: string
          notes?: string | null
          past_due_at?: string | null
          seat_plan_id: string
          seats_used?: number
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Update: {
          canceled_at?: string | null
          clone_id?: string | null
          created_at?: string
          current_period_end?: string | null
          expires_at?: string | null
          granted_at?: string
          id?: string
          notes?: string | null
          past_due_at?: string | null
          seat_plan_id?: string
          seats_used?: number
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "clone_seat_entitlements_seat_plan_id_fkey"
            columns: ["seat_plan_id"]
            isOneToOne: false
            referencedRelation: "seat_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      clone_seats: {
        Row: {
          clone_id: string | null
          committed_at: string | null
          created_at: string
          device_count: number
          display_name: string | null
          email: string | null
          external_user_id: string
          id: string
          idempotency_key: string | null
          metadata: Json
          removed_at: string | null
          reservation_expires_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          clone_id?: string | null
          committed_at?: string | null
          created_at?: string
          device_count?: number
          display_name?: string | null
          email?: string | null
          external_user_id: string
          id?: string
          idempotency_key?: string | null
          metadata?: Json
          removed_at?: string | null
          reservation_expires_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          clone_id?: string | null
          committed_at?: string | null
          created_at?: string
          device_count?: number
          display_name?: string | null
          email?: string | null
          external_user_id?: string
          id?: string
          idempotency_key?: string | null
          metadata?: Json
          removed_at?: string | null
          reservation_expires_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      clone_stripe_configs: {
        Row: {
          activated_at: string | null
          clone_id: string
          created_at: string
          created_by: string | null
          forward_url: string | null
          metadata: Json
          mode: Database["public"]["Enums"]["clone_stripe_mode"]
          rotated_at: string | null
          status: Database["public"]["Enums"]["clone_stripe_status"]
          stripe_account_id: string | null
          updated_at: string
          webhook_secret_ciphertext: string | null
          webhook_secret_last4: string | null
        }
        Insert: {
          activated_at?: string | null
          clone_id: string
          created_at?: string
          created_by?: string | null
          forward_url?: string | null
          metadata?: Json
          mode?: Database["public"]["Enums"]["clone_stripe_mode"]
          rotated_at?: string | null
          status?: Database["public"]["Enums"]["clone_stripe_status"]
          stripe_account_id?: string | null
          updated_at?: string
          webhook_secret_ciphertext?: string | null
          webhook_secret_last4?: string | null
        }
        Update: {
          activated_at?: string | null
          clone_id?: string
          created_at?: string
          created_by?: string | null
          forward_url?: string | null
          metadata?: Json
          mode?: Database["public"]["Enums"]["clone_stripe_mode"]
          rotated_at?: string | null
          status?: Database["public"]["Enums"]["clone_stripe_status"]
          stripe_account_id?: string | null
          updated_at?: string
          webhook_secret_ciphertext?: string | null
          webhook_secret_last4?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clone_stripe_configs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clone_stripe_configs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: true
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      clones: {
        Row: {
          billing_stripe_customer_id: string | null
          billing_user_id: string | null
          cloudflare_enabled: boolean
          cloudflare_zone_id: string | null
          commits_behind: number
          created_at: string
          default_branch: string
          deploy_url: string | null
          drift_suggestions: Json
          github_owner: string
          github_repo: string
          github_url: string | null
          id: string
          idempotency_key: string | null
          isolated_tenant: boolean
          last_cascade_at: string | null
          last_drift_check_at: string | null
          last_synced_sha: string | null
          lovable_project_id: string | null
          lovable_project_url: string | null
          name: string
          notes: string | null
          owner_user_id: string | null
          provisioning_method: Database["public"]["Enums"]["provisioning_method"]
          slug: string
          subdomain: string | null
          subdomain_fqdn: string | null
          subdomain_status: string | null
          sync_status: Database["public"]["Enums"]["sync_status"]
          tags: string[] | null
          updated_at: string
        }
        Insert: {
          billing_stripe_customer_id?: string | null
          billing_user_id?: string | null
          cloudflare_enabled?: boolean
          cloudflare_zone_id?: string | null
          commits_behind?: number
          created_at?: string
          default_branch?: string
          deploy_url?: string | null
          drift_suggestions?: Json
          github_owner: string
          github_repo: string
          github_url?: string | null
          id?: string
          idempotency_key?: string | null
          isolated_tenant?: boolean
          last_cascade_at?: string | null
          last_drift_check_at?: string | null
          last_synced_sha?: string | null
          lovable_project_id?: string | null
          lovable_project_url?: string | null
          name: string
          notes?: string | null
          owner_user_id?: string | null
          provisioning_method: Database["public"]["Enums"]["provisioning_method"]
          slug: string
          subdomain?: string | null
          subdomain_fqdn?: string | null
          subdomain_status?: string | null
          sync_status?: Database["public"]["Enums"]["sync_status"]
          tags?: string[] | null
          updated_at?: string
        }
        Update: {
          billing_stripe_customer_id?: string | null
          billing_user_id?: string | null
          cloudflare_enabled?: boolean
          cloudflare_zone_id?: string | null
          commits_behind?: number
          created_at?: string
          default_branch?: string
          deploy_url?: string | null
          drift_suggestions?: Json
          github_owner?: string
          github_repo?: string
          github_url?: string | null
          id?: string
          idempotency_key?: string | null
          isolated_tenant?: boolean
          last_cascade_at?: string | null
          last_drift_check_at?: string | null
          last_synced_sha?: string | null
          lovable_project_id?: string | null
          lovable_project_url?: string | null
          name?: string
          notes?: string | null
          owner_user_id?: string | null
          provisioning_method?: Database["public"]["Enums"]["provisioning_method"]
          slug?: string
          subdomain?: string | null
          subdomain_fqdn?: string | null
          subdomain_status?: string | null
          sync_status?: Database["public"]["Enums"]["sync_status"]
          tags?: string[] | null
          updated_at?: string
        }
        Relationships: []
      }
      cloudflare_accounts: {
        Row: {
          account_id: string
          account_name: string | null
          created_at: string
          created_by: string | null
          email: string | null
          id: string
          is_active: boolean
          token_secret_name: string
          updated_at: string
        }
        Insert: {
          account_id: string
          account_name?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          token_secret_name?: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          account_name?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          token_secret_name?: string
          updated_at?: string
        }
        Relationships: []
      }
      cloudflare_audit: {
        Row: {
          action: string
          actor_user_id: string | null
          clone_id: string | null
          created_at: string
          error_message: string | null
          id: string
          payload: Json
          result: Json
          success: boolean
          zone_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          payload?: Json
          result?: Json
          success?: boolean
          zone_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          payload?: Json
          result?: Json
          success?: boolean
          zone_id?: string | null
        }
        Relationships: []
      }
      cloudflare_clone_config: {
        Row: {
          account_id: string
          bot_fight_mode: boolean
          clone_id: string
          created_at: string
          id: string
          last_synced_at: string | null
          plan: string | null
          posture: Json
          rate_limit_rps: number | null
          security_level: string | null
          status: string
          updated_at: string
          waf_preset: string | null
          zone_id: string
          zone_name: string
        }
        Insert: {
          account_id: string
          bot_fight_mode?: boolean
          clone_id: string
          created_at?: string
          id?: string
          last_synced_at?: string | null
          plan?: string | null
          posture?: Json
          rate_limit_rps?: number | null
          security_level?: string | null
          status?: string
          updated_at?: string
          waf_preset?: string | null
          zone_id: string
          zone_name: string
        }
        Update: {
          account_id?: string
          bot_fight_mode?: boolean
          clone_id?: string
          created_at?: string
          id?: string
          last_synced_at?: string | null
          plan?: string | null
          posture?: Json
          rate_limit_rps?: number | null
          security_level?: string | null
          status?: string
          updated_at?: string
          waf_preset?: string | null
          zone_id?: string
          zone_name?: string
        }
        Relationships: []
      }
      edge_audit: {
        Row: {
          action: string
          actor_user_id: string | null
          clone_id: string | null
          created_at: string
          error_message: string | null
          external_ref: string | null
          id: string
          payload: Json
          provider_slug: string
          result: Json
          success: boolean
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          error_message?: string | null
          external_ref?: string | null
          id?: string
          payload?: Json
          provider_slug: string
          result?: Json
          success: boolean
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          error_message?: string | null
          external_ref?: string | null
          id?: string
          payload?: Json
          provider_slug?: string
          result?: Json
          success?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "edge_audit_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edge_audit_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      edge_dns_records: {
        Row: {
          clone_id: string
          created_at: string
          created_by: string | null
          external_record_id: string
          id: string
          managed: boolean
          provider_slug: string
          proxied: boolean
          purpose: string
          record_content: string
          record_name: string
          record_type: string
          updated_at: string
          zone_id: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          created_by?: string | null
          external_record_id: string
          id?: string
          managed?: boolean
          provider_slug?: string
          proxied?: boolean
          purpose?: string
          record_content: string
          record_name: string
          record_type: string
          updated_at?: string
          zone_id: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          created_by?: string | null
          external_record_id?: string
          id?: string
          managed?: boolean
          provider_slug?: string
          proxied?: boolean
          purpose?: string
          record_content?: string
          record_name?: string
          record_type?: string
          updated_at?: string
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "edge_dns_records_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edge_dns_records_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      edge_posture_presets: {
        Row: {
          created_at: string
          description: string | null
          display_name: string
          is_default: boolean
          settings: Json
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          display_name: string
          is_default?: boolean
          settings?: Json
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          display_name?: string
          is_default?: boolean
          settings?: Json
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      edge_providers: {
        Row: {
          capabilities: Json
          created_at: string
          display_name: string
          slug: string
          sort_order: number
          status: string
          updated_at: string
        }
        Insert: {
          capabilities?: Json
          created_at?: string
          display_name: string
          slug: string
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Update: {
          capabilities?: Json
          created_at?: string
          display_name?: string
          slug?: string
          sort_order?: number
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      edge_provisioning_jobs: {
        Row: {
          action: string
          attempts: number
          clone_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          locked_at: string | null
          locked_by: string | null
          max_attempts: number
          next_attempt_at: string
          payload: Json
          payload_hash: string
          provider_slug: string
          result: Json | null
          status: string
          updated_at: string
        }
        Insert: {
          action: string
          attempts?: number
          clone_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          next_attempt_at?: string
          payload?: Json
          payload_hash: string
          provider_slug: string
          result?: Json | null
          status?: string
          updated_at?: string
        }
        Update: {
          action?: string
          attempts?: number
          clone_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          max_attempts?: number
          next_attempt_at?: string
          payload?: Json
          payload_hash?: string
          provider_slug?: string
          result?: Json | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "edge_provisioning_jobs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "edge_provisioning_jobs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "edge_provisioning_jobs_provider_slug_fkey"
            columns: ["provider_slug"]
            isOneToOne: false
            referencedRelation: "edge_providers"
            referencedColumns: ["slug"]
          },
        ]
      }
      fleet_digests: {
        Row: {
          created_at: string
          generated_by_model: string | null
          id: string
          metrics: Json
          period_end: string
          period_start: string
          summary_markdown: string
        }
        Insert: {
          created_at?: string
          generated_by_model?: string | null
          id?: string
          metrics?: Json
          period_end: string
          period_start: string
          summary_markdown: string
        }
        Update: {
          created_at?: string
          generated_by_model?: string | null
          id?: string
          metrics?: Json
          period_end?: string
          period_start?: string
          summary_markdown?: string
        }
        Relationships: []
      }
      handoff_audit_events: {
        Row: {
          action: string | null
          actor: string | null
          handoff_id: string
          id: string
          occurred_at: string | null
          payload: Json
          received_at: string
          source_event_id: string
          source_project_ref: string | null
          source_table: string | null
        }
        Insert: {
          action?: string | null
          actor?: string | null
          handoff_id: string
          id?: string
          occurred_at?: string | null
          payload?: Json
          received_at?: string
          source_event_id: string
          source_project_ref?: string | null
          source_table?: string | null
        }
        Update: {
          action?: string | null
          actor?: string | null
          handoff_id?: string
          id?: string
          occurred_at?: string | null
          payload?: Json
          received_at?: string
          source_event_id?: string
          source_project_ref?: string | null
          source_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "handoff_audit_events_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_audit_shippers: {
        Row: {
          created_at: string
          enabled: boolean
          endpoint_url: string
          filter: Json
          handoff_id: string
          hmac_secret: string
          id: string
          last_error: string | null
          last_event_at: string | null
          last_shipped_at: string | null
          total_shipped: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          endpoint_url: string
          filter?: Json
          handoff_id: string
          hmac_secret: string
          id?: string
          last_error?: string | null
          last_event_at?: string | null
          last_shipped_at?: string | null
          total_shipped?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          endpoint_url?: string
          filter?: Json
          handoff_id?: string
          hmac_secret?: string
          id?: string
          last_error?: string | null
          last_event_at?: string | null
          last_shipped_at?: string | null
          total_shipped?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_audit_shippers_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: true
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_billing_splits: {
        Row: {
          aurixa_products_kept: Json
          aurixa_stripe_customer_id: string | null
          aurixa_stripe_subscription_id: string | null
          client_billed_directly: boolean
          client_supabase_org_id: string | null
          client_supabase_plan: string | null
          clone_id: string
          created_at: string
          created_by: string | null
          decoupled_at: string | null
          disclosed_to_client_at: string | null
          handoff_id: string
          id: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          aurixa_products_kept?: Json
          aurixa_stripe_customer_id?: string | null
          aurixa_stripe_subscription_id?: string | null
          client_billed_directly?: boolean
          client_supabase_org_id?: string | null
          client_supabase_plan?: string | null
          clone_id: string
          created_at?: string
          created_by?: string | null
          decoupled_at?: string | null
          disclosed_to_client_at?: string | null
          handoff_id: string
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          aurixa_products_kept?: Json
          aurixa_stripe_customer_id?: string | null
          aurixa_stripe_subscription_id?: string | null
          client_billed_directly?: boolean
          client_supabase_org_id?: string | null
          client_supabase_plan?: string | null
          clone_id?: string
          created_at?: string
          created_by?: string | null
          decoupled_at?: string | null
          disclosed_to_client_at?: string | null
          handoff_id?: string
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_billing_splits_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handoff_billing_splits_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "handoff_billing_splits_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: true
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_contracts: {
        Row: {
          created_at: string
          document_storage_path: string | null
          handoff_id: string
          id: string
          ip_address: string | null
          metadata: Json
          pdf_storage_path: string | null
          signature_bundle_sha256: string | null
          signed_at: string | null
          signed_by_email: string | null
          signed_by_name: string | null
          snapshot_manifest: Json
          terms_hash: string
          terms_version_id: string | null
          user_agent: string | null
          version: string
        }
        Insert: {
          created_at?: string
          document_storage_path?: string | null
          handoff_id: string
          id?: string
          ip_address?: string | null
          metadata?: Json
          pdf_storage_path?: string | null
          signature_bundle_sha256?: string | null
          signed_at?: string | null
          signed_by_email?: string | null
          signed_by_name?: string | null
          snapshot_manifest?: Json
          terms_hash: string
          terms_version_id?: string | null
          user_agent?: string | null
          version: string
        }
        Update: {
          created_at?: string
          document_storage_path?: string | null
          handoff_id?: string
          id?: string
          ip_address?: string | null
          metadata?: Json
          pdf_storage_path?: string | null
          signature_bundle_sha256?: string | null
          signed_at?: string | null
          signed_by_email?: string | null
          signed_by_name?: string | null
          snapshot_manifest?: Json
          terms_hash?: string
          terms_version_id?: string | null
          user_agent?: string | null
          version?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_contracts_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handoff_contracts_terms_version_id_fkey"
            columns: ["terms_version_id"]
            isOneToOne: false
            referencedRelation: "handoff_terms_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_cost_exports: {
        Row: {
          error: string | null
          generated_at: string
          handoff_id: string
          id: string
          period_end: string
          period_start: string
          rows_included: number | null
          status: string
          storage_path: string | null
          total_cents: number | null
          total_tokens: number | null
        }
        Insert: {
          error?: string | null
          generated_at?: string
          handoff_id: string
          id?: string
          period_end: string
          period_start: string
          rows_included?: number | null
          status?: string
          storage_path?: string | null
          total_cents?: number | null
          total_tokens?: number | null
        }
        Update: {
          error?: string | null
          generated_at?: string
          handoff_id?: string
          id?: string
          period_end?: string
          period_start?: string
          rows_included?: number | null
          status?: string
          storage_path?: string | null
          total_cents?: number | null
          total_tokens?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "handoff_cost_exports_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_events: {
        Row: {
          actor_user_id: string | null
          created_at: string
          details: Json
          handoff_id: string
          id: string
          kind: string
        }
        Insert: {
          actor_user_id?: string | null
          created_at?: string
          details?: Json
          handoff_id: string
          id?: string
          kind: string
        }
        Update: {
          actor_user_id?: string | null
          created_at?: string
          details?: Json
          handoff_id?: string
          id?: string
          kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_events_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_invites: {
        Row: {
          consumed_at: string | null
          consumed_ip: string | null
          created_at: string
          created_by: string | null
          expires_at: string
          handoff_id: string
          id: string
          plan_allowlist: string[]
          region_allowlist: string[]
          revoked_at: string | null
          revoked_reason: string | null
          terms_body: string | null
          terms_hash: string
          terms_version: string
          token_hash: string
          token_prefix: string
          updated_at: string
        }
        Insert: {
          consumed_at?: string | null
          consumed_ip?: string | null
          created_at?: string
          created_by?: string | null
          expires_at: string
          handoff_id: string
          id?: string
          plan_allowlist?: string[]
          region_allowlist?: string[]
          revoked_at?: string | null
          revoked_reason?: string | null
          terms_body?: string | null
          terms_hash: string
          terms_version: string
          token_hash: string
          token_prefix: string
          updated_at?: string
        }
        Update: {
          consumed_at?: string | null
          consumed_ip?: string | null
          created_at?: string
          created_by?: string | null
          expires_at?: string
          handoff_id?: string
          id?: string
          plan_allowlist?: string[]
          region_allowlist?: string[]
          revoked_at?: string | null
          revoked_reason?: string | null
          terms_body?: string | null
          terms_hash?: string
          terms_version?: string
          token_hash?: string
          token_prefix?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_invites_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_observability_configs: {
        Row: {
          clone_id: string
          created_at: string
          created_by: string | null
          handoff_id: string
          id: string
          last_error: string | null
          last_poll_at: string | null
          last_snapshot: Json
          last_status: string | null
          mode: string
          next_poll_at: string | null
          notes: string | null
          poll_interval_seconds: number
          updated_at: string
        }
        Insert: {
          clone_id: string
          created_at?: string
          created_by?: string | null
          handoff_id: string
          id?: string
          last_error?: string | null
          last_poll_at?: string | null
          last_snapshot?: Json
          last_status?: string | null
          mode?: string
          next_poll_at?: string | null
          notes?: string | null
          poll_interval_seconds?: number
          updated_at?: string
        }
        Update: {
          clone_id?: string
          created_at?: string
          created_by?: string | null
          handoff_id?: string
          id?: string
          last_error?: string | null
          last_poll_at?: string | null
          last_snapshot?: Json
          last_status?: string | null
          mode?: string
          next_poll_at?: string | null
          notes?: string | null
          poll_interval_seconds?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_observability_configs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "handoff_observability_configs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "handoff_observability_configs_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: true
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_parity_reports: {
        Row: {
          auth_diff: Json
          blocking_issues: Json
          buckets_diff: Json
          cron_diff: Json
          edge_functions_diff: Json
          extensions_diff: Json
          functions_diff: Json
          generated_at: string
          handoff_id: string
          id: string
          policies_diff: Json
          prime_ref: string | null
          risk_level: string
          secrets_diff: Json
          summary: string | null
          tables_diff: Json
          target_ref: string | null
        }
        Insert: {
          auth_diff?: Json
          blocking_issues?: Json
          buckets_diff?: Json
          cron_diff?: Json
          edge_functions_diff?: Json
          extensions_diff?: Json
          functions_diff?: Json
          generated_at?: string
          handoff_id: string
          id?: string
          policies_diff?: Json
          prime_ref?: string | null
          risk_level?: string
          secrets_diff?: Json
          summary?: string | null
          tables_diff?: Json
          target_ref?: string | null
        }
        Update: {
          auth_diff?: Json
          blocking_issues?: Json
          buckets_diff?: Json
          cron_diff?: Json
          edge_functions_diff?: Json
          extensions_diff?: Json
          functions_diff?: Json
          generated_at?: string
          handoff_id?: string
          id?: string
          policies_diff?: Json
          prime_ref?: string | null
          risk_level?: string
          secrets_diff?: Json
          summary?: string | null
          tables_diff?: Json
          target_ref?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "handoff_parity_reports_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_region_plan_policies: {
        Row: {
          allowed_plans: string[]
          allowed_regions: string[]
          created_at: string
          id: string
          is_active: boolean
          min_plan: string | null
          name: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          allowed_plans?: string[]
          allowed_regions?: string[]
          created_at?: string
          id?: string
          is_active?: boolean
          min_plan?: string | null
          name: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          allowed_plans?: string[]
          allowed_regions?: string[]
          created_at?: string
          id?: string
          is_active?: boolean
          min_plan?: string | null
          name?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      handoff_secret_rotations: {
        Row: {
          created_at: string
          error: string | null
          handoff_id: string
          id: string
          key_ref: string
          metadata: Json
          rotated_at: string | null
          status: string
          target: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error?: string | null
          handoff_id: string
          id?: string
          key_ref: string
          metadata?: Json
          rotated_at?: string | null
          status?: string
          target: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error?: string | null
          handoff_id?: string
          id?: string
          key_ref?: string
          metadata?: Json
          rotated_at?: string | null
          status?: string
          target?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_secret_rotations_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_snapshots: {
        Row: {
          created_at: string
          error: string | null
          handoff_id: string
          id: string
          kind: string
          metadata: Json
          retention_expires_at: string | null
          sha256: string | null
          size_bytes: number | null
          status: string
          storage_path: string | null
        }
        Insert: {
          created_at?: string
          error?: string | null
          handoff_id: string
          id?: string
          kind: string
          metadata?: Json
          retention_expires_at?: string | null
          sha256?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
        }
        Update: {
          created_at?: string
          error?: string | null
          handoff_id?: string
          id?: string
          kind?: string
          metadata?: Json
          retention_expires_at?: string | null
          sha256?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "handoff_snapshots_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_storage_replications: {
        Row: {
          bucket_id: string
          bytes_copied: number
          completed_at: string | null
          created_at: string
          cursor_offset: number
          cursor_prefix: string | null
          handoff_id: string
          id: string
          last_error: string | null
          last_run_at: string | null
          objects_copied: number
          objects_failed: number
          objects_scanned: number
          objects_skipped: number
          status: string
          updated_at: string
        }
        Insert: {
          bucket_id: string
          bytes_copied?: number
          completed_at?: string | null
          created_at?: string
          cursor_offset?: number
          cursor_prefix?: string | null
          handoff_id: string
          id?: string
          last_error?: string | null
          last_run_at?: string | null
          objects_copied?: number
          objects_failed?: number
          objects_scanned?: number
          objects_skipped?: number
          status?: string
          updated_at?: string
        }
        Update: {
          bucket_id?: string
          bytes_copied?: number
          completed_at?: string | null
          created_at?: string
          cursor_offset?: number
          cursor_prefix?: string | null
          handoff_id?: string
          id?: string
          last_error?: string | null
          last_run_at?: string | null
          objects_copied?: number
          objects_failed?: number
          objects_scanned?: number
          objects_skipped?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "handoff_storage_replications_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "clone_handoffs"
            referencedColumns: ["id"]
          },
        ]
      }
      handoff_terms_versions: {
        Row: {
          body_md: string
          created_at: string
          created_by: string | null
          effective_at: string | null
          id: string
          is_active: boolean
          metadata: Json
          retired_at: string | null
          terms_hash: string
          title: string
          updated_at: string
          version: string
        }
        Insert: {
          body_md: string
          created_at?: string
          created_by?: string | null
          effective_at?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          retired_at?: string | null
          terms_hash: string
          title: string
          updated_at?: string
          version: string
        }
        Update: {
          body_md?: string
          created_at?: string
          created_by?: string | null
          effective_at?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          retired_at?: string | null
          terms_hash?: string
          title?: string
          updated_at?: string
          version?: string
        }
        Relationships: []
      }
      module_cascade_jobs: {
        Row: {
          cascade_event_id: string | null
          clone_ids: string[]
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          initiated_by: string | null
          metadata: Json
          module_ids: string[]
          status: string
          updated_at: string
        }
        Insert: {
          cascade_event_id?: string | null
          clone_ids?: string[]
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          initiated_by?: string | null
          metadata?: Json
          module_ids?: string[]
          status?: string
          updated_at?: string
        }
        Update: {
          cascade_event_id?: string | null
          clone_ids?: string[]
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          initiated_by?: string | null
          metadata?: Json
          module_ids?: string[]
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      module_config_snapshots: {
        Row: {
          clone_id: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          label: string
          module_ids: string[]
        }
        Insert: {
          clone_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          label?: string
          module_ids?: string[]
        }
        Update: {
          clone_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          label?: string
          module_ids?: string[]
        }
        Relationships: []
      }
      module_detection_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          delta_mode: boolean | null
          dependency_count: number | null
          error_message: string | null
          file_count: number | null
          id: string
          initiated_by: string | null
          inserted_modules: number | null
          orphan_files_found: number | null
          parameters: Json | null
          pass_count: number | null
          passes: Json | null
          previous_run_id: string | null
          proposed_modules: number | null
          sampled_file_count: number | null
          started_at: string | null
          status: string
          strategy: string
          tree_hash: string | null
          updated_at: string
          updated_modules: number | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          delta_mode?: boolean | null
          dependency_count?: number | null
          error_message?: string | null
          file_count?: number | null
          id?: string
          initiated_by?: string | null
          inserted_modules?: number | null
          orphan_files_found?: number | null
          parameters?: Json | null
          pass_count?: number | null
          passes?: Json | null
          previous_run_id?: string | null
          proposed_modules?: number | null
          sampled_file_count?: number | null
          started_at?: string | null
          status?: string
          strategy?: string
          tree_hash?: string | null
          updated_at?: string
          updated_modules?: number | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          delta_mode?: boolean | null
          dependency_count?: number | null
          error_message?: string | null
          file_count?: number | null
          id?: string
          initiated_by?: string | null
          inserted_modules?: number | null
          orphan_files_found?: number | null
          parameters?: Json | null
          pass_count?: number | null
          passes?: Json | null
          previous_run_id?: string | null
          proposed_modules?: number | null
          sampled_file_count?: number | null
          started_at?: string | null
          status?: string
          strategy?: string
          tree_hash?: string | null
          updated_at?: string
          updated_modules?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "module_detection_runs_previous_run_id_fkey"
            columns: ["previous_run_id"]
            isOneToOne: false
            referencedRelation: "module_detection_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      module_drift_alerts: {
        Row: {
          alert_type: string
          created_at: string
          detection_run_id: string | null
          file_path: string | null
          id: string
          module_id: string | null
          reasoning: string | null
          resolved: boolean
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          suggested_module_slug: string | null
        }
        Insert: {
          alert_type: string
          created_at?: string
          detection_run_id?: string | null
          file_path?: string | null
          id?: string
          module_id?: string | null
          reasoning?: string | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          suggested_module_slug?: string | null
        }
        Update: {
          alert_type?: string
          created_at?: string
          detection_run_id?: string | null
          file_path?: string | null
          id?: string
          module_id?: string | null
          reasoning?: string | null
          resolved?: boolean
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          suggested_module_slug?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "module_drift_alerts_detection_run_id_fkey"
            columns: ["detection_run_id"]
            isOneToOne: false
            referencedRelation: "module_detection_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "module_drift_alerts_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
        ]
      }
      module_import_edges: {
        Row: {
          created_at: string
          detection_run_id: string
          id: string
          import_type: string
          source_file: string
          target_file: string
        }
        Insert: {
          created_at?: string
          detection_run_id: string
          id?: string
          import_type?: string
          source_file: string
          target_file: string
        }
        Update: {
          created_at?: string
          detection_run_id?: string
          id?: string
          import_type?: string
          source_file?: string
          target_file?: string
        }
        Relationships: [
          {
            foreignKeyName: "module_import_edges_detection_run_id_fkey"
            columns: ["detection_run_id"]
            isOneToOne: false
            referencedRelation: "module_detection_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      module_library: {
        Row: {
          approval_status: string
          approved_at: string | null
          approved_by: string | null
          created_at: string
          deprecated_at: string | null
          deprecated_reason: string | null
          description: string | null
          entry_file: string
          file_count: number
          file_paths: string[]
          id: string
          is_latest: boolean
          metadata: Json
          name: string
          published_at: string
          published_by: string | null
          rejection_reason: string | null
          replacement_slug: string | null
          route_path: string | null
          slug: string
          source_detection_run_id: string | null
          source_module_id: string | null
          tags: string[]
          updated_at: string
          version: number
        }
        Insert: {
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          deprecated_at?: string | null
          deprecated_reason?: string | null
          description?: string | null
          entry_file: string
          file_count?: number
          file_paths?: string[]
          id?: string
          is_latest?: boolean
          metadata?: Json
          name: string
          published_at?: string
          published_by?: string | null
          rejection_reason?: string | null
          replacement_slug?: string | null
          route_path?: string | null
          slug: string
          source_detection_run_id?: string | null
          source_module_id?: string | null
          tags?: string[]
          updated_at?: string
          version?: number
        }
        Update: {
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          deprecated_at?: string | null
          deprecated_reason?: string | null
          description?: string | null
          entry_file?: string
          file_count?: number
          file_paths?: string[]
          id?: string
          is_latest?: boolean
          metadata?: Json
          name?: string
          published_at?: string
          published_by?: string | null
          rejection_reason?: string | null
          replacement_slug?: string | null
          route_path?: string | null
          slug?: string
          source_detection_run_id?: string | null
          source_module_id?: string | null
          tags?: string[]
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      modules: {
        Row: {
          ai_confidence: number | null
          ai_reasoning: string | null
          apply_on_install: boolean
          approved_at: string | null
          approved_by: string | null
          clone_migration_sql: string | null
          cohesion_score: number | null
          coupling_score: number | null
          created_at: string
          dependencies: string[]
          description: string | null
          detected_by_ai: boolean
          detection_run_id: string | null
          file_globs: string[]
          id: string
          incompatible_with: string[]
          name: string
          orphan_file_count: number | null
          rejection_reason: string | null
          requires: string[]
          resolved_files: string[]
          route_entry_file: string | null
          routes: string[]
          shared_by_modules: string[]
          slug: string
          status: Database["public"]["Enums"]["module_status"]
          tree_snapshot_hash: string | null
          updated_at: string
        }
        Insert: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          apply_on_install?: boolean
          approved_at?: string | null
          approved_by?: string | null
          clone_migration_sql?: string | null
          cohesion_score?: number | null
          coupling_score?: number | null
          created_at?: string
          dependencies?: string[]
          description?: string | null
          detected_by_ai?: boolean
          detection_run_id?: string | null
          file_globs?: string[]
          id?: string
          incompatible_with?: string[]
          name: string
          orphan_file_count?: number | null
          rejection_reason?: string | null
          requires?: string[]
          resolved_files?: string[]
          route_entry_file?: string | null
          routes?: string[]
          shared_by_modules?: string[]
          slug: string
          status?: Database["public"]["Enums"]["module_status"]
          tree_snapshot_hash?: string | null
          updated_at?: string
        }
        Update: {
          ai_confidence?: number | null
          ai_reasoning?: string | null
          apply_on_install?: boolean
          approved_at?: string | null
          approved_by?: string | null
          clone_migration_sql?: string | null
          cohesion_score?: number | null
          coupling_score?: number | null
          created_at?: string
          dependencies?: string[]
          description?: string | null
          detected_by_ai?: boolean
          detection_run_id?: string | null
          file_globs?: string[]
          id?: string
          incompatible_with?: string[]
          name?: string
          orphan_file_count?: number | null
          rejection_reason?: string | null
          requires?: string[]
          resolved_files?: string[]
          route_entry_file?: string | null
          routes?: string[]
          shared_by_modules?: string[]
          slug?: string
          status?: Database["public"]["Enums"]["module_status"]
          tree_snapshot_hash?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "modules_detection_run_id_fkey"
            columns: ["detection_run_id"]
            isOneToOne: false
            referencedRelation: "module_detection_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_preferences: {
        Row: {
          created_at: string
          digest_mode: string
          id: string
          mute_browser_push: boolean
          mute_toasts: boolean
          muted_kinds: Database["public"]["Enums"]["notification_kind"][]
          muted_severities: Database["public"]["Enums"]["notification_severity"][]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          digest_mode?: string
          id?: string
          mute_browser_push?: boolean
          mute_toasts?: boolean
          muted_kinds?: Database["public"]["Enums"]["notification_kind"][]
          muted_severities?: Database["public"]["Enums"]["notification_severity"][]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          digest_mode?: string
          id?: string
          mute_browser_push?: boolean
          mute_toasts?: boolean
          muted_kinds?: Database["public"]["Enums"]["notification_kind"][]
          muted_severities?: Database["public"]["Enums"]["notification_severity"][]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          body: string | null
          cascade_event_id: string | null
          clone_id: string | null
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["notification_kind"]
          metadata: Json
          read_at: string | null
          severity: Database["public"]["Enums"]["notification_severity"]
          title: string
          url: string | null
        }
        Insert: {
          body?: string | null
          cascade_event_id?: string | null
          clone_id?: string | null
          created_at?: string
          id?: string
          kind: Database["public"]["Enums"]["notification_kind"]
          metadata?: Json
          read_at?: string | null
          severity?: Database["public"]["Enums"]["notification_severity"]
          title: string
          url?: string | null
        }
        Update: {
          body?: string | null
          cascade_event_id?: string | null
          clone_id?: string | null
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["notification_kind"]
          metadata?: Json
          read_at?: string | null
          severity?: Database["public"]["Enums"]["notification_severity"]
          title?: string
          url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_cascade_event_id_fkey"
            columns: ["cascade_event_id"]
            isOneToOne: false
            referencedRelation: "cascade_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      platform_hosting_config: {
        Row: {
          auto_provision: boolean
          cloudflare_account_id: string | null
          cloudflare_zone_id: string | null
          cloudflare_zone_name: string | null
          created_at: string
          id: string
          primary_domain: string
          provider_slug: string
          proxied: boolean
          reserved_slugs: string[]
          singleton: boolean
          subdomain_pattern: string
          target_type: string
          target_value: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          auto_provision?: boolean
          cloudflare_account_id?: string | null
          cloudflare_zone_id?: string | null
          cloudflare_zone_name?: string | null
          created_at?: string
          id?: string
          primary_domain?: string
          provider_slug?: string
          proxied?: boolean
          reserved_slugs?: string[]
          singleton?: boolean
          subdomain_pattern?: string
          target_type?: string
          target_value?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          auto_provision?: boolean
          cloudflare_account_id?: string | null
          cloudflare_zone_id?: string | null
          cloudflare_zone_name?: string | null
          created_at?: string
          id?: string
          primary_domain?: string
          provider_slug?: string
          proxied?: boolean
          reserved_slugs?: string[]
          singleton?: boolean
          subdomain_pattern?: string
          target_type?: string
          target_value?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      prime_config: {
        Row: {
          created_at: string
          default_branch: string
          default_cascade_mode: Database["public"]["Enums"]["cascade_mode"]
          default_clone_org: string | null
          github_app_installation_id: string | null
          github_owner: string
          github_repo: string
          id: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_branch?: string
          default_cascade_mode?: Database["public"]["Enums"]["cascade_mode"]
          default_clone_org?: string | null
          github_app_installation_id?: string | null
          github_owner: string
          github_repo: string
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_branch?: string
          default_cascade_mode?: Database["public"]["Enums"]["cascade_mode"]
          default_clone_org?: string | null
          github_app_installation_id?: string | null
          github_owner?: string
          github_repo?: string
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      prime_secret_forwards: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          inherit: boolean
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          inherit?: boolean
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          inherit?: boolean
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          display_name: string | null
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          display_name?: string | null
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      purchases: {
        Row: {
          amount_cents: number | null
          clone_id: string | null
          completed_at: string | null
          created_at: string
          currency: string | null
          handoff_id: string | null
          id: string
          item_id: string | null
          item_slug: string | null
          metadata: Json
          mode: string
          origin_source: string
          origin_user_id: string | null
          origin_username: string | null
          payment_status: string | null
          quantity: number
          status: string
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          stripe_subscription_id: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents?: number | null
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          currency?: string | null
          handoff_id?: string | null
          id?: string
          item_id?: string | null
          item_slug?: string | null
          metadata?: Json
          mode: string
          origin_source?: string
          origin_user_id?: string | null
          origin_username?: string | null
          payment_status?: string | null
          quantity?: number
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number | null
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          currency?: string | null
          handoff_id?: string | null
          id?: string
          item_id?: string | null
          item_slug?: string | null
          metadata?: Json
          mode?: string
          origin_source?: string
          origin_user_id?: string | null
          origin_username?: string | null
          payment_status?: string | null
          quantity?: number
          status?: string
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_subscription_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchases_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "purchases_handoff_id_fkey"
            columns: ["handoff_id"]
            isOneToOne: false
            referencedRelation: "billing_handoffs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      push_delivery_log: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          notification_id: string | null
          status_code: number | null
          subscription_id: string | null
          success: boolean
          user_id: string | null
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          notification_id?: string | null
          status_code?: number | null
          subscription_id?: string | null
          success: boolean
          user_id?: string | null
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          notification_id?: string | null
          status_code?: number | null
          subscription_id?: string | null
          success?: boolean
          user_id?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_used_at: string
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_used_at?: string
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_used_at?: string
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      report_credit_costs: {
        Row: {
          category: string
          created_at: string
          credit_cost: number
          description: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          category?: string
          created_at?: string
          credit_cost?: number
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          credit_cost?: number
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      report_jobs: {
        Row: {
          charged_tokens: number
          clone_id: string | null
          completed_at: string | null
          created_at: string
          error: string | null
          estimated_tokens: number
          id: string
          idempotency_key: string
          kind: string
          request_payload: Json
          reservation_expires_at: string | null
          result_meta: Json
          started_at: string
          status: Database["public"]["Enums"]["report_job_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          charged_tokens?: number
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          estimated_tokens?: number
          id?: string
          idempotency_key: string
          kind: string
          request_payload?: Json
          reservation_expires_at?: string | null
          result_meta?: Json
          started_at?: string
          status?: Database["public"]["Enums"]["report_job_status"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          charged_tokens?: number
          clone_id?: string | null
          completed_at?: string | null
          created_at?: string
          error?: string | null
          estimated_tokens?: number
          id?: string
          idempotency_key?: string
          kind?: string
          request_payload?: Json
          reservation_expires_at?: string | null
          result_meta?: Json
          started_at?: string
          status?: Database["public"]["Enums"]["report_job_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_jobs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_jobs_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "report_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      route_errors: {
        Row: {
          created_at: string
          id: string
          message: string
          metadata: Json | null
          route_path: string
          stack: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          message: string
          metadata?: Json | null
          route_path: string
          stack?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          message?: string
          metadata?: Json | null
          route_path?: string
          stack?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      seat_audit: {
        Row: {
          action: string
          actor_user_id: string | null
          clone_id: string | null
          created_at: string
          external_user_id: string | null
          id: string
          metadata: Json
          seat_id: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          external_user_id?: string | null
          id?: string
          metadata?: Json
          seat_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          external_user_id?: string | null
          id?: string
          metadata?: Json
          seat_id?: string | null
        }
        Relationships: []
      }
      seat_plans: {
        Row: {
          created_at: string
          currency: string
          description: string | null
          device_limit_per_seat: number | null
          id: string
          is_active: boolean
          is_default: boolean
          metadata: Json
          name: string
          overage_policy: string
          price_cents: number
          seat_limit: number
          slug: string
          stripe_price_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          description?: string | null
          device_limit_per_seat?: number | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          metadata?: Json
          name: string
          overage_policy?: string
          price_cents?: number
          seat_limit: number
          slug: string
          stripe_price_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          description?: string | null
          device_limit_per_seat?: number | null
          id?: string
          is_active?: boolean
          is_default?: boolean
          metadata?: Json
          name?: string
          overage_policy?: string
          price_cents?: number
          seat_limit?: number
          slug?: string
          stripe_price_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      seat_roles: {
        Row: {
          created_at: string
          currency: string
          description: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          permissions: Json
          price_max_cents: number
          price_min_cents: number
          slug: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          permissions?: Json
          price_max_cents?: number
          price_min_cents?: number
          slug: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          permissions?: Json
          price_max_cents?: number
          price_min_cents?: number
          slug?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      security_assessment_comments: {
        Row: {
          assessment_id: string
          author_kind: string
          author_user_id: string | null
          body: string
          clone_id: string
          created_at: string
          id: string
          metadata: Json
          partner_id: string
          visibility: string
        }
        Insert: {
          assessment_id: string
          author_kind: string
          author_user_id?: string | null
          body: string
          clone_id: string
          created_at?: string
          id?: string
          metadata?: Json
          partner_id: string
          visibility?: string
        }
        Update: {
          assessment_id?: string
          author_kind?: string
          author_user_id?: string | null
          body?: string
          clone_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          partner_id?: string
          visibility?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_assessment_comments_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "security_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessment_comments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessment_comments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_assessment_comments_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_assessment_events: {
        Row: {
          actor_kind: string
          actor_user_id: string | null
          assessment_id: string | null
          body: string | null
          clone_id: string | null
          created_at: string
          event_type: string
          id: string
          metadata: Json
          partner_id: string | null
        }
        Insert: {
          actor_kind?: string
          actor_user_id?: string | null
          assessment_id?: string | null
          body?: string | null
          clone_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          partner_id?: string | null
        }
        Update: {
          actor_kind?: string
          actor_user_id?: string | null
          assessment_id?: string | null
          body?: string | null
          clone_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          partner_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "security_assessment_events_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "security_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessment_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessment_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_assessment_events_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_assessments: {
        Row: {
          assignment_id: string | null
          aurixa_review_status: string
          client_release_approved: boolean
          clone_id: string
          completed_at: string | null
          created_at: string
          created_by: string | null
          cycle: string
          due_at: string | null
          emergency_stop_contact: string | null
          escalation_contacts: Json
          exclusions: string | null
          id: string
          partner_id: string
          remediation_owner: string | null
          retest_required: boolean
          rules_of_engagement: string | null
          scope_summary: string | null
          started_at: string | null
          status: string
          target_urls: string[]
          testing_window_end: string | null
          testing_window_start: string | null
          title: string
          updated_at: string
        }
        Insert: {
          assignment_id?: string | null
          aurixa_review_status?: string
          client_release_approved?: boolean
          clone_id: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          cycle?: string
          due_at?: string | null
          emergency_stop_contact?: string | null
          escalation_contacts?: Json
          exclusions?: string | null
          id?: string
          partner_id: string
          remediation_owner?: string | null
          retest_required?: boolean
          rules_of_engagement?: string | null
          scope_summary?: string | null
          started_at?: string | null
          status?: string
          target_urls?: string[]
          testing_window_end?: string | null
          testing_window_start?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          assignment_id?: string | null
          aurixa_review_status?: string
          client_release_approved?: boolean
          clone_id?: string
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          cycle?: string
          due_at?: string | null
          emergency_stop_contact?: string | null
          escalation_contacts?: Json
          exclusions?: string | null
          id?: string
          partner_id?: string
          remediation_owner?: string | null
          retest_required?: boolean
          rules_of_engagement?: string | null
          scope_summary?: string | null
          started_at?: string | null
          status?: string
          target_urls?: string[]
          testing_window_end?: string | null
          testing_window_start?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_assessments_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "security_partner_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_assessments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_assessments_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_findings: {
        Row: {
          affected_asset: string | null
          assessment_id: string
          clone_id: string
          created_at: string
          cvss: string | null
          cwe: string | null
          description: string | null
          evidence: string | null
          id: string
          partner_id: string
          recommendation: string | null
          resolved_at: string | null
          retest_status: string
          severity: string
          status: string
          submitted_by: string | null
          title: string
          updated_at: string
        }
        Insert: {
          affected_asset?: string | null
          assessment_id: string
          clone_id: string
          created_at?: string
          cvss?: string | null
          cwe?: string | null
          description?: string | null
          evidence?: string | null
          id?: string
          partner_id: string
          recommendation?: string | null
          resolved_at?: string | null
          retest_status?: string
          severity?: string
          status?: string
          submitted_by?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          affected_asset?: string | null
          assessment_id?: string
          clone_id?: string
          created_at?: string
          cvss?: string | null
          cwe?: string | null
          description?: string | null
          evidence?: string | null
          id?: string
          partner_id?: string
          recommendation?: string | null
          resolved_at?: string | null
          retest_status?: string
          severity?: string
          status?: string
          submitted_by?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_findings_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "security_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_findings_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_findings_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_findings_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_partner_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          clone_id: string
          created_at: string
          id: string
          metadata: Json
          partner_id: string
          revoked_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          clone_id: string
          created_at?: string
          id?: string
          metadata?: Json
          partner_id: string
          revoked_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          clone_id?: string
          created_at?: string
          id?: string
          metadata?: Json
          partner_id?: string
          revoked_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_partner_assignments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_partner_assignments_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_partner_assignments_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_partner_memberships: {
        Row: {
          accepted_at: string | null
          approved_at: string | null
          approved_by: string | null
          created_at: string
          display_name: string | null
          email: string
          id: string
          last_seen_at: string | null
          partner_id: string
          role: string
          status: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          accepted_at?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          display_name?: string | null
          email: string
          id?: string
          last_seen_at?: string | null
          partner_id: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          accepted_at?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          last_seen_at?: string | null
          partner_id?: string
          role?: string
          status?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "security_partner_memberships_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      security_partners: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          metadata: Json
          name: string
          notes: string | null
          primary_contact_email: string | null
          primary_contact_name: string | null
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          metadata?: Json
          name: string
          notes?: string | null
          primary_contact_email?: string | null
          primary_contact_name?: string | null
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          metadata?: Json
          name?: string
          notes?: string | null
          primary_contact_email?: string | null
          primary_contact_name?: string | null
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      security_reports: {
        Row: {
          assessment_id: string
          clone_id: string
          created_at: string
          file_path: string | null
          file_url: string | null
          id: string
          label: string
          notes: string | null
          partner_id: string
          report_type: string
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          submitted_at: string
          submitted_by: string | null
          updated_at: string
        }
        Insert: {
          assessment_id: string
          clone_id: string
          created_at?: string
          file_path?: string | null
          file_url?: string | null
          id?: string
          label: string
          notes?: string | null
          partner_id: string
          report_type?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          assessment_id?: string
          clone_id?: string
          created_at?: string
          file_path?: string | null
          file_url?: string | null
          id?: string
          label?: string
          notes?: string | null
          partner_id?: string
          report_type?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          submitted_at?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_reports_assessment_id_fkey"
            columns: ["assessment_id"]
            isOneToOne: false
            referencedRelation: "security_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_reports_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "security_reports_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "security_reports_partner_id_fkey"
            columns: ["partner_id"]
            isOneToOne: false
            referencedRelation: "security_partners"
            referencedColumns: ["id"]
          },
        ]
      }
      setup_packages: {
        Row: {
          applies_to_plans: string[]
          created_at: string
          currency: string
          deliverables: Json
          description: string | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          price_max_cents: number
          price_min_cents: number
          slug: string
          sort_order: number
          stripe_price_id: string | null
          updated_at: string
        }
        Insert: {
          applies_to_plans?: string[]
          created_at?: string
          currency?: string
          deliverables?: Json
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          price_max_cents?: number
          price_min_cents?: number
          slug: string
          sort_order?: number
          stripe_price_id?: string | null
          updated_at?: string
        }
        Update: {
          applies_to_plans?: string[]
          created_at?: string
          currency?: string
          deliverables?: Json
          description?: string | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          price_max_cents?: number
          price_min_cents?: number
          slug?: string
          sort_order?: number
          stripe_price_id?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      setup_purchases: {
        Row: {
          amount_cents: number | null
          created_at: string
          currency: string | null
          fulfilled_at: string | null
          id: string
          metadata: Json
          refund_amount_cents: number | null
          refunded_at: string | null
          setup_package_id: string | null
          status: string
          stripe_charge_id: string | null
          stripe_checkout_session_id: string | null
          stripe_payment_intent_id: string | null
          tenant_id: string | null
          updated_at: string
        }
        Insert: {
          amount_cents?: number | null
          created_at?: string
          currency?: string | null
          fulfilled_at?: string | null
          id?: string
          metadata?: Json
          refund_amount_cents?: number | null
          refunded_at?: string | null
          setup_package_id?: string | null
          status?: string
          stripe_charge_id?: string | null
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_cents?: number | null
          created_at?: string
          currency?: string | null
          fulfilled_at?: string | null
          id?: string
          metadata?: Json
          refund_amount_cents?: number | null
          refunded_at?: string | null
          setup_package_id?: string | null
          status?: string
          stripe_charge_id?: string | null
          stripe_checkout_session_id?: string | null
          stripe_payment_intent_id?: string | null
          tenant_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "setup_purchases_setup_package_id_fkey"
            columns: ["setup_package_id"]
            isOneToOne: false
            referencedRelation: "setup_packages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "setup_purchases_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_events: {
        Row: {
          clone_id: string | null
          created_at: string
          error: string | null
          id: string
          payload: Json
          processed_at: string | null
          stripe_account_id: string | null
          stripe_event_id: string
          type: string
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          payload: Json
          processed_at?: string | null
          stripe_account_id?: string | null
          stripe_event_id: string
          type: string
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          error?: string | null
          id?: string
          payload?: Json
          processed_at?: string | null
          stripe_account_id?: string | null
          stripe_event_id?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_events_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
        ]
      }
      tenants: {
        Row: {
          billing_exempt: boolean
          billing_stripe_customer_id: string | null
          billing_user_id: string | null
          clone_id: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          display_name: string | null
          external_ref: string
          id: string
          metadata: Json
          plan_id: string | null
          plan_started_at: string | null
          status: Database["public"]["Enums"]["tenant_status"]
          stripe_customer_id: string | null
          updated_at: string
        }
        Insert: {
          billing_exempt?: boolean
          billing_stripe_customer_id?: string | null
          billing_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          display_name?: string | null
          external_ref: string
          id?: string
          metadata?: Json
          plan_id?: string | null
          plan_started_at?: string | null
          status?: Database["public"]["Enums"]["tenant_status"]
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Update: {
          billing_exempt?: boolean
          billing_stripe_customer_id?: string | null
          billing_user_id?: string | null
          clone_id?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          display_name?: string | null
          external_ref?: string
          id?: string
          metadata?: Json
          plan_id?: string | null
          plan_started_at?: string | null
          status?: Database["public"]["Enums"]["tenant_status"]
          stripe_customer_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenants_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenants_clone_id_fkey"
            columns: ["clone_id"]
            isOneToOne: false
            referencedRelation: "clones_missing_isolated_backend"
            referencedColumns: ["clone_id"]
          },
          {
            foreignKeyName: "tenants_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "billing_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      token_api_rate_limits: {
        Row: {
          count: number
          key_id: string
          window_start: string
        }
        Insert: {
          count?: number
          key_id: string
          window_start: string
        }
        Update: {
          count?: number
          key_id?: string
          window_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "token_api_rate_limits_key_id_fkey"
            columns: ["key_id"]
            isOneToOne: false
            referencedRelation: "clone_api_keys"
            referencedColumns: ["id"]
          },
        ]
      }
      token_balances: {
        Row: {
          available: number
          lifetime_granted: number
          lifetime_spent: number
          reserved: number
          tenant_id: string
          updated_at: string
        }
        Insert: {
          available?: number
          lifetime_granted?: number
          lifetime_spent?: number
          reserved?: number
          tenant_id: string
          updated_at?: string
        }
        Update: {
          available?: number
          lifetime_granted?: number
          lifetime_spent?: number
          reserved?: number
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "token_balances_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      token_ledger: {
        Row: {
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          kind: Database["public"]["Enums"]["ledger_kind"]
          metadata: Json
          reason: string | null
          report_job_id: string | null
          source: Database["public"]["Enums"]["ledger_source"]
          source_ref: string | null
          tenant_id: string
          tokens: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          kind: Database["public"]["Enums"]["ledger_kind"]
          metadata?: Json
          reason?: string | null
          report_job_id?: string | null
          source: Database["public"]["Enums"]["ledger_source"]
          source_ref?: string | null
          tenant_id: string
          tokens: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["ledger_kind"]
          metadata?: Json
          reason?: string | null
          report_job_id?: string | null
          source?: Database["public"]["Enums"]["ledger_source"]
          source_ref?: string | null
          tenant_id?: string
          tokens?: number
        }
        Relationships: [
          {
            foreignKeyName: "token_ledger_report_job_id_fkey"
            columns: ["report_job_id"]
            isOneToOne: false
            referencedRelation: "report_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "token_ledger_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      token_rates: {
        Row: {
          base_cost: number
          created_at: string
          effective_from: string
          id: string
          kind: string
          notes: string | null
          per_unit: Json
          updated_at: string
        }
        Insert: {
          base_cost?: number
          created_at?: string
          effective_from?: string
          id?: string
          kind: string
          notes?: string | null
          per_unit?: Json
          updated_at?: string
        }
        Update: {
          base_cost?: number
          created_at?: string
          effective_from?: string
          id?: string
          kind?: string
          notes?: string | null
          per_unit?: Json
          updated_at?: string
        }
        Relationships: []
      }
      token_webhook_deliveries: {
        Row: {
          attempts: number
          created_at: string
          delivered_at: string | null
          endpoint_id: string
          event_type: string
          id: string
          next_attempt_at: string | null
          payload: Json
          response_body: string | null
          response_code: number | null
          status: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id: string
          event_type: string
          id?: string
          next_attempt_at?: string | null
          payload?: Json
          response_body?: string | null
          response_code?: number | null
          status?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          delivered_at?: string | null
          endpoint_id?: string
          event_type?: string
          id?: string
          next_attempt_at?: string | null
          payload?: Json
          response_body?: string | null
          response_code?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "token_webhook_deliveries_endpoint_id_fkey"
            columns: ["endpoint_id"]
            isOneToOne: false
            referencedRelation: "token_webhook_endpoints"
            referencedColumns: ["id"]
          },
        ]
      }
      token_webhook_endpoints: {
        Row: {
          clone_id: string | null
          created_at: string
          created_by: string | null
          events: string[]
          id: string
          is_active: boolean
          secret: string
          updated_at: string
          url: string
        }
        Insert: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          events?: string[]
          id?: string
          is_active?: boolean
          secret: string
          updated_at?: string
          url: string
        }
        Update: {
          clone_id?: string | null
          created_at?: string
          created_by?: string | null
          events?: string[]
          id?: string
          is_active?: boolean
          secret?: string
          updated_at?: string
          url?: string
        }
        Relationships: []
      }
      topup_packs: {
        Row: {
          created_at: string
          currency: string
          expires_after_days: number | null
          id: string
          is_active: boolean
          metadata: Json
          name: string
          price_cents: number
          slug: string
          stripe_price_id: string | null
          tokens: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          expires_after_days?: number | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name: string
          price_cents: number
          slug: string
          stripe_price_id?: string | null
          tokens: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          expires_after_days?: number | null
          id?: string
          is_active?: boolean
          metadata?: Json
          name?: string
          price_cents?: number
          slug?: string
          stripe_price_id?: string | null
          tokens?: number
          updated_at?: string
        }
        Relationships: []
      }
      user_preferences: {
        Row: {
          created_at: string
          id: string
          name: string
          payload: Json
          scope: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          payload?: Json
          scope: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          payload?: Json
          scope?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_invites: {
        Row: {
          accepted_at: string | null
          accepted_user_id: string | null
          created_at: string
          email: string | null
          expires_at: string
          id: string
          invited_by: string
          note: string | null
          revoked_at: string | null
          revoked_by: string | null
          role: Database["public"]["Enums"]["app_role"]
          token_hash: string
          token_prefix: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_user_id?: string | null
          created_at?: string
          email?: string | null
          expires_at: string
          id?: string
          invited_by: string
          note?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          token_hash: string
          token_prefix: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_user_id?: string | null
          created_at?: string
          email?: string | null
          expires_at?: string
          id?: string
          invited_by?: string
          note?: string | null
          revoked_at?: string | null
          revoked_by?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          token_hash?: string
          token_prefix?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      waitlist_leads: {
        Row: {
          created_at: string
          dedupe_key: string | null
          email: string
          entity_classification: string | null
          entity_name: string | null
          first_name: string
          id: string
          last_name: string
          metadata: Json
          mobile_number: string | null
          notes: string | null
          page: string | null
          source: string
          status: Database["public"]["Enums"]["lead_status"]
          submitted_at: string | null
          tech_stack_bottlenecks: string | null
          transaction_volume: string | null
        }
        Insert: {
          created_at?: string
          dedupe_key?: string | null
          email: string
          entity_classification?: string | null
          entity_name?: string | null
          first_name: string
          id?: string
          last_name: string
          metadata?: Json
          mobile_number?: string | null
          notes?: string | null
          page?: string | null
          source?: string
          status?: Database["public"]["Enums"]["lead_status"]
          submitted_at?: string | null
          tech_stack_bottlenecks?: string | null
          transaction_volume?: string | null
        }
        Update: {
          created_at?: string
          dedupe_key?: string | null
          email?: string
          entity_classification?: string | null
          entity_name?: string | null
          first_name?: string
          id?: string
          last_name?: string
          metadata?: Json
          mobile_number?: string | null
          notes?: string | null
          page?: string | null
          source?: string
          status?: Database["public"]["Enums"]["lead_status"]
          submitted_at?: string | null
          tech_stack_bottlenecks?: string | null
          transaction_volume?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      clone_backends_safe: {
        Row: {
          admin_email: string | null
          clone_id: string | null
          created_at: string | null
          edge_functions: Json | null
          error_message: string | null
          id: string | null
          migration_version: string | null
          migrations_applied: Json | null
          region: string | null
          secret_shells: Json | null
          source_ref: string | null
          source_repo: string | null
          source_sha: string | null
          status: Database["public"]["Enums"]["clone_backend_status"] | null
          status_detail: string | null
          supabase_project_ref: string | null
          supabase_url: string | null
          updated_at: string | null
        }
        Insert: {
          admin_email?: string | null
          clone_id?: string | null
          created_at?: string | null
          edge_functions?: Json | null
          error_message?: string | null
          id?: string | null
          migration_version?: string | null
          migrations_applied?: Json | null
          region?: string | null
          secret_shells?: Json | null
          source_ref?: string | null
          source_repo?: string | null
          source_sha?: string | null
          status?: Database["public"]["Enums"]["clone_backend_status"] | null
          status_detail?: string | null
          supabase_project_ref?: string | null
          supabase_url?: string | null
          updated_at?: string | null
        }
        Update: {
          admin_email?: string | null
          clone_id?: string | null
          created_at?: string | null
          edge_functions?: Json | null
          error_message?: string | null
          id?: string | null
          migration_version?: string | null
          migrations_applied?: Json | null
          region?: string | null
          secret_shells?: Json | null
          source_ref?: string | null
          source_repo?: string | null
          source_sha?: string | null
          status?: Database["public"]["Enums"]["clone_backend_status"] | null
          status_detail?: string | null
          supabase_project_ref?: string | null
          supabase_url?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      clones_missing_isolated_backend: {
        Row: {
          backend_status: string | null
          clone_id: string | null
          created_at: string | null
          name: string | null
          owner_user_id: string | null
          provisioning_method:
            | Database["public"]["Enums"]["provisioning_method"]
            | null
          slug: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      apply_topup: {
        Args: {
          _metadata?: Json
          _pack_id: string
          _source_ref?: string
          _tenant_id: string
        }
        Returns: Json
      }
      can_access_security_assessment: {
        Args: { _assessment_id: string }
        Returns: boolean
      }
      can_assign_role: {
        Args: {
          _assigner_id: string
          _target_role: Database["public"]["Enums"]["app_role"]
        }
        Returns: boolean
      }
      can_manage_user: {
        Args: { _manager_id: string; _target_user_id: string }
        Returns: boolean
      }
      cancel_token_reservation: {
        Args: { _job_id: string; _reason?: string }
        Returns: Json
      }
      check_api_rate_limit: {
        Args: { _key_id: string; _limit?: number }
        Returns: Json
      }
      cleanup_billing_attribution: { Args: never; Returns: Json }
      clone_has_dedicated_backend: {
        Args: { _clone_id: string }
        Returns: boolean
      }
      clone_requires_backend: { Args: { _clone_id: string }; Returns: boolean }
      commit_seat: { Args: { _seat_id: string }; Returns: Json }
      commit_tokens: {
        Args: { _actual_tokens: number; _job_id: string; _result_meta?: Json }
        Returns: Json
      }
      entitlement_for_subscription: {
        Args: { _sub_id: string }
        Returns: {
          clone_id: string
          id: string
          seat_plan_id: string
          status: string
        }[]
      }
      expire_stale_reservations: { Args: never; Returns: Json }
      expire_stale_seat_reservations: { Args: never; Returns: Json }
      grant_tokens: {
        Args: {
          _expires_at?: string
          _reason: string
          _tenant_id: string
          _tokens: number
        }
        Returns: Json
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      heartbeat_device: { Args: { _device_id: string }; Returns: Json }
      highest_role_level: { Args: { _user_id: string }; Returns: number }
      is_admin: { Args: { _user_id: string }; Returns: boolean }
      is_high_king: { Args: { _user_id: string }; Returns: boolean }
      is_operator: { Args: { _user_id: string }; Returns: boolean }
      is_super_admin: { Args: { _user_id: string }; Returns: boolean }
      is_security_partner_member: {
        Args: { _partner_id: string }
        Returns: boolean
      }
      purge_log_tables: {
        Args: never
        Returns: {
          deleted_rows: number
          table_name: string
        }[]
      }
      recompute_seat_device_count: {
        Args: { _seat_id: string }
        Returns: number
      }
      recompute_seats_used: { Args: { _clone_id: string }; Returns: number }
      recompute_token_balance: {
        Args: { _tenant_id: string }
        Returns: undefined
      }
      refund_job: { Args: { _job_id: string; _reason?: string }; Returns: Json }
      register_device: {
        Args: {
          _clone_id: string
          _device_fingerprint: string
          _device_label?: string
          _external_user_id: string
          _ip_address?: string
          _platform?: string
          _user_agent?: string
        }
        Returns: Json
      }
      release_device: {
        Args: {
          _clone_id?: string
          _device_fingerprint?: string
          _device_id?: string
          _external_user_id?: string
          _reason?: string
        }
        Returns: Json
      }
      release_seat: {
        Args: { _clone_id: string; _external_user_id: string; _reason?: string }
        Returns: Json
      }
      reserve_seat: {
        Args: {
          _clone_id: string
          _display_name: string
          _email: string
          _external_user_id: string
          _idempotency_key: string
          _ttl_seconds?: number
        }
        Returns: Json
      }
      reserve_tokens: {
        Args: {
          _clone_id: string
          _estimated_tokens: number
          _idempotency_key: string
          _kind: string
          _request_payload?: Json
          _tenant_id: string
          _ttl_seconds?: number
        }
        Returns: Json
      }
      revoke_scheduled_keys: { Args: never; Returns: Json }
      role_level: {
        Args: { _role: Database["public"]["Enums"]["app_role"] }
        Returns: number
      }
      schedule_key_revoke: {
        Args: { _at: string; _key_id: string }
        Returns: Json
      }
      security_storage_assessment_id: {
        Args: { object_name: string }
        Returns: string
      }
      tenant_usage_summary: { Args: { _tenant_id: string }; Returns: Json }
    }
    Enums: {
      app_role: "high_king" | "super_admin" | "admin" | "operator" | "user"
      brand_assignment_status: "pending" | "applied" | "drifted" | "failed"
      brand_profile_status: "draft" | "published" | "archived"
      cascade_event_status:
        | "pending"
        | "running"
        | "completed"
        | "failed"
        | "partial"
      cascade_mode: "pr" | "auto_merge" | "notify"
      cascade_result_status:
        | "queued"
        | "pushing"
        | "succeeded"
        | "failed"
        | "pr_opened"
        | "skipped"
      cascade_schedule_kind: "fleet_cascade" | "module_sync" | "brand_sync"
      cascade_trigger: "manual" | "commit" | "scheduled"
      clone_backend_status:
        | "pending"
        | "provisioning"
        | "migrating"
        | "seeding_admin"
        | "ready"
        | "failed"
        | "suspended"
      clone_stripe_mode: "platform" | "own_account" | "connect"
      clone_stripe_status: "pending" | "active" | "rotated" | "revoked"
      drift_severity: "low" | "medium" | "high"
      handoff_path: "rebuild_twin" | "enterprise_transfer"
      handoff_state:
        | "draft"
        | "dry_run_ready"
        | "awaiting_client_consent"
        | "snapshot_pending"
        | "snapshot_ready"
        | "twin_provisioning"
        | "twin_ready"
        | "data_syncing"
        | "cutover_scheduled"
        | "cutover_in_progress"
        | "complete"
        | "rolled_back"
        | "failed"
        | "canceled"
      lead_status:
        | "new"
        | "contacted"
        | "qualified"
        | "disqualified"
        | "converted"
      ledger_kind:
        | "grant"
        | "topup"
        | "debit"
        | "refund"
        | "adjustment"
        | "expiry"
        | "reserve"
        | "release"
      ledger_source: "subscription" | "topup" | "manual" | "system" | "report"
      module_status: "proposed" | "approved" | "archived" | "rejected"
      notification_kind:
        | "cascade_completed"
        | "cascade_failed"
        | "cascade_partial"
        | "cascade_started"
        | "drift_high"
        | "drift_medium"
        | "clone_created"
        | "clone_deleted"
        | "module_installed"
        | "module_removed"
        | "cascade_awaiting_approval"
        | "cascade_approved"
        | "cascade_rejected"
        | "library_entry_approved"
        | "library_entry_rejected"
        | "tokens_alert"
        | "tokens_key_first_use"
        | "tokens_key_issued"
        | "tokens_key_rotated"
        | "seat_limit_approaching"
        | "seat_limit_reached"
        | "seat_plan_changed"
        | "device_limit_reached"
        | "device_registered"
        | "device_released"
        | "lead_captured"
        | "purchase_completed"
      notification_severity: "info" | "success" | "warning" | "error"
      overage_policy: "block" | "topup_only" | "pay_as_you_go"
      provisioning_method: "fork" | "template" | "clone"
      report_job_status:
        | "pending"
        | "reserved"
        | "completed"
        | "failed"
        | "refunded"
        | "canceled"
      sync_status: "in_sync" | "behind" | "cascading" | "failed" | "unknown"
      tenant_status: "active" | "past_due" | "canceled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["high_king", "super_admin", "admin", "operator", "user"],
      brand_assignment_status: ["pending", "applied", "drifted", "failed"],
      brand_profile_status: ["draft", "published", "archived"],
      cascade_event_status: [
        "pending",
        "running",
        "completed",
        "failed",
        "partial",
      ],
      cascade_mode: ["pr", "auto_merge", "notify"],
      cascade_result_status: [
        "queued",
        "pushing",
        "succeeded",
        "failed",
        "pr_opened",
        "skipped",
      ],
      cascade_schedule_kind: ["fleet_cascade", "module_sync", "brand_sync"],
      cascade_trigger: ["manual", "commit", "scheduled"],
      clone_backend_status: [
        "pending",
        "provisioning",
        "migrating",
        "seeding_admin",
        "ready",
        "failed",
        "suspended",
      ],
      clone_stripe_mode: ["platform", "own_account", "connect"],
      clone_stripe_status: ["pending", "active", "rotated", "revoked"],
      drift_severity: ["low", "medium", "high"],
      handoff_path: ["rebuild_twin", "enterprise_transfer"],
      handoff_state: [
        "draft",
        "dry_run_ready",
        "awaiting_client_consent",
        "snapshot_pending",
        "snapshot_ready",
        "twin_provisioning",
        "twin_ready",
        "data_syncing",
        "cutover_scheduled",
        "cutover_in_progress",
        "complete",
        "rolled_back",
        "failed",
        "canceled",
      ],
      lead_status: [
        "new",
        "contacted",
        "qualified",
        "disqualified",
        "converted",
      ],
      ledger_kind: [
        "grant",
        "topup",
        "debit",
        "refund",
        "adjustment",
        "expiry",
        "reserve",
        "release",
      ],
      ledger_source: ["subscription", "topup", "manual", "system", "report"],
      module_status: ["proposed", "approved", "archived", "rejected"],
      notification_kind: [
        "cascade_completed",
        "cascade_failed",
        "cascade_partial",
        "cascade_started",
        "drift_high",
        "drift_medium",
        "clone_created",
        "clone_deleted",
        "module_installed",
        "module_removed",
        "cascade_awaiting_approval",
        "cascade_approved",
        "cascade_rejected",
        "library_entry_approved",
        "library_entry_rejected",
        "tokens_alert",
        "tokens_key_first_use",
        "tokens_key_issued",
        "tokens_key_rotated",
        "seat_limit_approaching",
        "seat_limit_reached",
        "seat_plan_changed",
        "device_limit_reached",
        "device_registered",
        "device_released",
        "lead_captured",
        "purchase_completed",
      ],
      notification_severity: ["info", "success", "warning", "error"],
      overage_policy: ["block", "topup_only", "pay_as_you_go"],
      provisioning_method: ["fork", "template", "clone"],
      report_job_status: [
        "pending",
        "reserved",
        "completed",
        "failed",
        "refunded",
        "canceled",
      ],
      sync_status: ["in_sync", "behind", "cascading", "failed", "unknown"],
      tenant_status: ["active", "past_due", "canceled"],
    },
  },
} as const
