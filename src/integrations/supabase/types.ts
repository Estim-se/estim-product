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
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      ai_calls: {
        Row: {
          company_id: string | null
          created_at: string
          duration_ms: number | null
          error: string | null
          id: string
          input: Json | null
          input_tokens: number | null
          model: string | null
          output: Json | null
          output_tokens: number | null
          prompt_version: string
          request_id: string | null
          step: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          input?: Json | null
          input_tokens?: number | null
          model?: string | null
          output?: Json | null
          output_tokens?: number | null
          prompt_version: string
          request_id?: string | null
          step: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          input?: Json | null
          input_tokens?: number | null
          model?: string | null
          output?: Json | null
          output_tokens?: number | null
          prompt_version?: string
          request_id?: string | null
          step?: string
        }
        Relationships: []
      }
      ai_jobs: {
        Row: {
          company_id: string
          created_at: string
          id: string
          incoming_message_id: string | null
          interpret: boolean
          state: string
          thread_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          incoming_message_id?: string | null
          interpret?: boolean
          state?: string
          thread_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          incoming_message_id?: string | null
          interpret?: boolean
          state?: string
          thread_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_jobs_incoming_message_id_fkey"
            columns: ["incoming_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_jobs_thread_id_fkey"
            columns: ["thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          actor_name: string
          after: Json | null
          approved_name: string
          before: Json | null
          company_id: string | null
          created_at: string
          event: string
          id: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          actor_name?: string
          after?: Json | null
          approved_name?: string
          before?: Json | null
          company_id?: string | null
          created_at?: string
          event: string
          id?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          actor_name?: string
          after?: Json | null
          approved_name?: string
          before?: Json | null
          company_id?: string | null
          created_at?: string
          event?: string
          id?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      channels: {
        Row: {
          company_id: string
          created_at: string
          id: string
          phone_number_id: string
          type: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          phone_number_id: string
          type: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          phone_number_id?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "channels_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          active: boolean
          company_id: string | null
          created_at: string
          created_by: string
          hourly_rate_ex_vat: number
          id: string
          inbound_address: string
          name: string
          rate_source: Json
          reply_to_email: string | null
          settings: Json
          signature: string
          travel_fee: number
          updated_at: string
          whatsapp_auto_reply: boolean
        }
        Insert: {
          active?: boolean
          company_id?: string | null
          created_at?: string
          created_by?: string
          hourly_rate_ex_vat?: number
          id?: string
          inbound_address: string
          name: string
          rate_source?: Json
          reply_to_email?: string | null
          settings?: Json
          signature?: string
          travel_fee?: number
          updated_at?: string
          whatsapp_auto_reply?: boolean
        }
        Update: {
          active?: boolean
          company_id?: string | null
          created_at?: string
          created_by?: string
          hourly_rate_ex_vat?: number
          id?: string
          inbound_address?: string
          name?: string
          rate_source?: Json
          reply_to_email?: string | null
          settings?: Json
          signature?: string
          travel_fee?: number
          updated_at?: string
          whatsapp_auto_reply?: boolean
        }
        Relationships: []
      }
      company_branding: {
        Row: {
          company_id: string
          created_at: string
          logo_path: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          logo_path: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          logo_path?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_branding_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      company_document_deliveries: {
        Row: {
          company_id: string
          created_at: string
          document_id: string
          file_name: string
          file_path: string
          id: string
          message_id: string
          name: string
          provider_message_id: string | null
          source_message_id: string | null
          state: string
          thread_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          document_id: string
          file_name: string
          file_path: string
          id?: string
          message_id: string
          name: string
          provider_message_id?: string | null
          source_message_id?: string | null
          state?: string
          thread_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          document_id?: string
          file_name?: string
          file_path?: string
          id?: string
          message_id?: string
          name?: string
          provider_message_id?: string | null
          source_message_id?: string | null
          state?: string
          thread_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_document_deliveries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_document_deliveries_company_id_thread_id_fkey"
            columns: ["company_id", "thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "company_document_deliveries_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "company_document_deliveries_source_message_id_fkey"
            columns: ["source_message_id"]
            isOneToOne: false
            referencedRelation: "messages"
            referencedColumns: ["id"]
          },
        ]
      }
      company_documents: {
        Row: {
          company_id: string
          created_at: string
          description: string
          doc_type: string
          file_name: string
          file_path: string
          id: string
          name: string
          updated_at: string
          uploaded_at: string
        }
        Insert: {
          company_id?: string
          created_at?: string
          description?: string
          doc_type: string
          file_name?: string
          file_path: string
          id?: string
          name: string
          updated_at?: string
          uploaded_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          description?: string
          doc_type?: string
          file_name?: string
          file_path?: string
          id?: string
          name?: string
          updated_at?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_documents_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      company_invitations: {
        Row: {
          accepted_at: string | null
          company_id: string
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          revoked_at: string | null
          role: string
          token_hash: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          accepted_at?: string | null
          company_id: string
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          revoked_at?: string | null
          role: string
          token_hash: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          accepted_at?: string | null
          company_id?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          revoked_at?: string | null
          role?: string
          token_hash?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "company_invitations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      company_members: {
        Row: {
          company_id: string
          created_at: string
          id: string
          role: string
          updated_at: string
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          role: string
          updated_at?: string
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          role?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_members_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          company_id: string
          created_at: string
          email: string | null
          id: string
          name: string
          phone: string | null
          place: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          company_id: string
          created_at?: string
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          place?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          company_id?: string
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          place?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      drafts: {
        Row: {
          attachments: Json
          channel: string
          company_id: string
          created_at: string
          document_ids: Json
          edited: boolean
          id: string
          needs_review: boolean
          text: string
          thread_id: string
          updated_at: string
          variant: string
          warnings: Json
        }
        Insert: {
          attachments?: Json
          channel?: string
          company_id: string
          created_at?: string
          document_ids?: Json
          edited?: boolean
          id?: string
          needs_review?: boolean
          text?: string
          thread_id: string
          updated_at?: string
          variant?: string
          warnings?: Json
        }
        Update: {
          attachments?: Json
          channel?: string
          company_id?: string
          created_at?: string
          document_ids?: Json
          edited?: boolean
          id?: string
          needs_review?: boolean
          text?: string
          thread_id?: string
          updated_at?: string
          variant?: string
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "drafts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drafts_company_id_thread_id_fkey"
            columns: ["company_id", "thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      email_connections: {
        Row: {
          company_id: string
          connected_by: string | null
          created_at: string
          email: string
          grant_id: string
          id: string
          last_event_at: string | null
          provider: string
          status: string
          updated_at: string
          watch_address: string | null
        }
        Insert: {
          company_id: string
          connected_by?: string | null
          created_at?: string
          email: string
          grant_id: string
          id?: string
          last_event_at?: string | null
          provider: string
          status?: string
          updated_at?: string
          watch_address?: string | null
        }
        Update: {
          company_id?: string
          connected_by?: string | null
          created_at?: string
          email?: string
          grant_id?: string
          id?: string
          last_event_at?: string | null
          provider?: string
          status?: string
          updated_at?: string
          watch_address?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "email_connections_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      login_attempts: {
        Row: {
          created_at: string
          email_hash: string
          failures: number
          lease_id: string | null
          lease_until: string | null
          locked_until: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          email_hash: string
          failures?: number
          lease_id?: string | null
          lease_until?: string | null
          locked_until?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          email_hash?: string
          failures?: number
          lease_id?: string | null
          lease_until?: string | null
          locked_until?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          approved_by: string | null
          attachment_files: Json
          attachments: Json
          channel: string | null
          company_id: string
          created_at: string
          delivery_error: string | null
          delivery_status: string
          document_ids: Json
          email_subject: string | null
          from: string
          id: string
          in_reply_to: string | null
          provider_message_id: string | null
          rfc_message_id: string | null
          sent_at: string
          text: string
          thread_id: string
          updated_at: string
        }
        Insert: {
          approved_by?: string | null
          attachment_files?: Json
          attachments?: Json
          channel?: string | null
          company_id: string
          created_at?: string
          delivery_error?: string | null
          delivery_status?: string
          document_ids?: Json
          email_subject?: string | null
          from: string
          id?: string
          in_reply_to?: string | null
          provider_message_id?: string | null
          rfc_message_id?: string | null
          sent_at?: string
          text: string
          thread_id: string
          updated_at?: string
        }
        Update: {
          approved_by?: string | null
          attachment_files?: Json
          attachments?: Json
          channel?: string | null
          company_id?: string
          created_at?: string
          delivery_error?: string | null
          delivery_status?: string
          document_ids?: Json
          email_subject?: string | null
          from?: string
          id?: string
          in_reply_to?: string | null
          provider_message_id?: string | null
          rfc_message_id?: string | null
          sent_at?: string
          text?: string
          thread_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_company_id_thread_id_fkey"
            columns: ["company_id", "thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      moments: {
        Row: {
          active: boolean
          company_id: string
          created_at: string
          hours_per_unit: number
          id: string
          material_per_unit_ex_vat: number
          name: string
          role: string
          rot_eligible: boolean
          source: Json
          unit: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          company_id: string
          created_at?: string
          hours_per_unit: number
          id?: string
          material_per_unit_ex_vat: number
          name: string
          role?: string
          rot_eligible?: boolean
          source?: Json
          unit: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          company_id?: string
          created_at?: string
          hours_per_unit?: number
          id?: string
          material_per_unit_ex_vat?: number
          name?: string
          role?: string
          rot_eligible?: boolean
          source?: Json
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "moments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_states: {
        Row: {
          company_id: string
          created_at: string
          expires_at: string
          state_hash: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          expires_at: string
          state_hash: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          expires_at?: string
          state_hash?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_states_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_admin_invitations: {
        Row: {
          accepted_at: string | null
          created_at: string
          email: string
          expires_at: string
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          email: string
          expires_at?: string
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_admins: {
        Row: {
          created_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          company_id: string | null
          created_at: string
          display_name: string
          id: string
          updated_at: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          display_name?: string
          id: string
          updated_at?: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          display_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          add_on: boolean
          company_id: string
          created_at: string
          id: string
          lines: Json
          nr: string
          owners: number
          prisform: string
          status: string
          thread_id: string
          updated_at: string
          version: number
        }
        Insert: {
          add_on?: boolean
          company_id: string
          created_at?: string
          id?: string
          lines?: Json
          nr: string
          owners?: number
          prisform?: string
          status?: string
          thread_id: string
          updated_at?: string
          version?: number
        }
        Update: {
          add_on?: boolean
          company_id?: string
          created_at?: string
          id?: string
          lines?: Json
          nr?: string
          owners?: number
          prisform?: string
          status?: string
          thread_id?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "quotes_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_company_id_thread_id_fkey"
            columns: ["company_id", "thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      samtal_a10_handoffs: {
        Row: {
          call_id: string
          company_id: string
          content_removed: boolean
          created_at: string
          customer_id: string
          message_id: string
          request_id: string
          thread_id: string
        }
        Insert: {
          call_id: string
          company_id: string
          content_removed?: boolean
          created_at?: string
          customer_id: string
          message_id: string
          request_id: string
          thread_id: string
        }
        Update: {
          call_id?: string
          company_id?: string
          content_removed?: boolean
          created_at?: string
          customer_id?: string
          message_id?: string
          request_id?: string
          thread_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_a10_handoffs_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: true
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      samtal_a9_matches: {
        Row: {
          assignment_candidates: string[]
          assignment_id: string | null
          assignment_truncated: boolean
          call_id: string
          company_id: string
          created_at: string
          customer_candidates: string[]
          customer_id: string | null
          customer_truncated: boolean
          intent: string | null
          quote_id: string | null
          quote_requested: boolean
          request_id: string | null
          state: string
          updated_at: string
          version: number
        }
        Insert: {
          assignment_candidates?: string[]
          assignment_id?: string | null
          assignment_truncated?: boolean
          call_id: string
          company_id: string
          created_at?: string
          customer_candidates?: string[]
          customer_id?: string | null
          customer_truncated?: boolean
          intent?: string | null
          quote_id?: string | null
          quote_requested?: boolean
          request_id?: string | null
          state?: string
          updated_at?: string
          version?: number
        }
        Update: {
          assignment_candidates?: string[]
          assignment_id?: string | null
          assignment_truncated?: boolean
          call_id?: string
          company_id?: string
          created_at?: string
          customer_candidates?: string[]
          customer_id?: string | null
          customer_truncated?: boolean
          intent?: string | null
          quote_id?: string | null
          quote_requested?: boolean
          request_id?: string | null
          state?: string
          updated_at?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "samtal_a9_matches_company_id_assignment_id_fkey"
            columns: ["company_id", "assignment_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_a9_matches_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: true
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_a9_matches_company_id_customer_id_fkey"
            columns: ["company_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_a9_matches_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_a9_quote_receipts: {
        Row: {
          call_id: string
          company_id: string
          created_at: string
          match_version: number
          quote_id: string
          quote_version: number
          updated_at: string
        }
        Insert: {
          call_id: string
          company_id: string
          created_at?: string
          match_version: number
          quote_id: string
          quote_version: number
          updated_at?: string
        }
        Update: {
          call_id?: string
          company_id?: string
          created_at?: string
          match_version?: number
          quote_id?: string
          quote_version?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_a9_quote_receipts_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: true
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
        ]
      }
      samtal_alert_notifications: {
        Row: {
          company_id: string
          created_at: string
          destination: string
          id: number
          level: string
          rule: string
        }
        Insert: {
          company_id: string
          created_at?: string
          destination?: string
          id?: number
          level: string
          rule: string
        }
        Update: {
          company_id?: string
          created_at?: string
          destination?: string
          id?: number
          level?: string
          rule?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_alert_notifications_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_alert_rules: {
        Row: {
          critical: number
          enabled: boolean
          metric: string
          rule: string
          warning: number
        }
        Insert: {
          critical: number
          enabled?: boolean
          metric: string
          rule: string
          warning: number
        }
        Update: {
          critical?: number
          enabled?: boolean
          metric?: string
          rule?: string
          warning?: number
        }
        Relationships: []
      }
      samtal_alerts: {
        Row: {
          company_id: string
          first_at: string
          last_at: string
          level: string
          notified_at: string | null
          notified_level: string | null
          rule: string
          value: number
        }
        Insert: {
          company_id: string
          first_at?: string
          last_at?: string
          level: string
          notified_at?: string | null
          notified_level?: string | null
          rule: string
          value: number
        }
        Update: {
          company_id?: string
          first_at?: string
          last_at?: string
          level?: string
          notified_at?: string | null
          notified_level?: string | null
          rule?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "samtal_alerts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_alerts_rule_fkey"
            columns: ["rule"]
            isOneToOne: false
            referencedRelation: "samtal_alert_rules"
            referencedColumns: ["rule"]
          },
        ]
      }
      samtal_audio_ledger: {
        Row: {
          attempts: number
          audio_path: string
          call_id: string | null
          cleanup_token: string | null
          cleanup_until: string | null
          closure_evidence: string | null
          company_id: string
          created_at: string
          error_code: string | null
          id: string
          queue: string
          retire_after: string | null
          retry_after: string
          state: string
          updated_at: string
          upload_token: string
          upload_until: string
          verification_count: number
          verified_at: string | null
          writer_closed_at: string | null
        }
        Insert: {
          attempts?: number
          audio_path: string
          call_id?: string | null
          cleanup_token?: string | null
          cleanup_until?: string | null
          closure_evidence?: string | null
          company_id: string
          created_at?: string
          error_code?: string | null
          id: string
          queue?: string
          retire_after?: string | null
          retry_after?: string
          state?: string
          updated_at?: string
          upload_token?: string
          upload_until?: string
          verification_count?: number
          verified_at?: string | null
          writer_closed_at?: string | null
        }
        Update: {
          attempts?: number
          audio_path?: string
          call_id?: string | null
          cleanup_token?: string | null
          cleanup_until?: string | null
          closure_evidence?: string | null
          company_id?: string
          created_at?: string
          error_code?: string | null
          id?: string
          queue?: string
          retire_after?: string | null
          retry_after?: string
          state?: string
          updated_at?: string
          upload_token?: string
          upload_until?: string
          verification_count?: number
          verified_at?: string | null
          writer_closed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "samtal_audio_ledger_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: false
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_audio_ledger_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_call_bindings: {
        Row: {
          account_id: string | null
          company_id: string
          created_at: string
          direction: string
          number_id: string
          provider: string
          provider_call_id: string
          recording_id: string | null
          user_id: string
        }
        Insert: {
          account_id?: string | null
          company_id: string
          created_at?: string
          direction: string
          number_id: string
          provider: string
          provider_call_id: string
          recording_id?: string | null
          user_id: string
        }
        Update: {
          account_id?: string | null
          company_id?: string
          created_at?: string
          direction?: string
          number_id?: string
          provider?: string
          provider_call_id?: string
          recording_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_call_bindings_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "samtal_provider_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_call_bindings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_call_bindings_provider_fkey"
            columns: ["provider"]
            isOneToOne: false
            referencedRelation: "samtal_webhook_providers"
            referencedColumns: ["provider"]
          },
        ]
      }
      samtal_calls: {
        Row: {
          audio_path: string | null
          caller_phone: string | null
          classification: string | null
          company_id: string
          content_deleted_at: string | null
          created_at: string
          customer_id: string | null
          delete_after: string
          duration_seconds: number | null
          ended_at: string | null
          error_code: string | null
          extraction: Json | null
          id: string
          kind: string
          number_id: string | null
          provider: string
          provider_call_id: string
          safety_version: number
          started_at: string
          status: string
          thread_id: string | null
          transcript: Json | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          audio_path?: string | null
          caller_phone?: string | null
          classification?: string | null
          company_id: string
          content_deleted_at?: string | null
          created_at?: string
          customer_id?: string | null
          delete_after: string
          duration_seconds?: number | null
          ended_at?: string | null
          error_code?: string | null
          extraction?: Json | null
          id?: string
          kind?: string
          number_id?: string | null
          provider: string
          provider_call_id: string
          safety_version?: number
          started_at: string
          status?: string
          thread_id?: string | null
          transcript?: Json | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          audio_path?: string | null
          caller_phone?: string | null
          classification?: string | null
          company_id?: string
          content_deleted_at?: string | null
          created_at?: string
          customer_id?: string | null
          delete_after?: string
          duration_seconds?: number | null
          ended_at?: string | null
          error_code?: string | null
          extraction?: Json | null
          id?: string
          kind?: string
          number_id?: string | null
          provider?: string
          provider_call_id?: string
          safety_version?: number
          started_at?: string
          status?: string
          thread_id?: string | null
          transcript?: Json | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "samtal_calls_company_id_customer_id_fkey"
            columns: ["company_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_calls_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_calls_company_id_number_id_fkey"
            columns: ["company_id", "number_id"]
            isOneToOne: false
            referencedRelation: "samtal_numbers"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_calls_company_id_thread_id_fkey"
            columns: ["company_id", "thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_calls_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_members"
            referencedColumns: ["company_id", "user_id"]
          },
        ]
      }
      samtal_dispatch_outbox: {
        Row: {
          accepted_at: string | null
          attempts: number
          call_id: string | null
          company_id: string
          completed_at: string | null
          created_at: string
          error_code: string | null
          id: string
          job_id: string | null
          lease_until: string | null
          next_attempt: string
          running_observed_at: string | null
          state: string
          token: string | null
          updated_at: string
        }
        Insert: {
          accepted_at?: string | null
          attempts?: number
          call_id?: string | null
          company_id: string
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          id?: string
          job_id?: string | null
          lease_until?: string | null
          next_attempt?: string
          running_observed_at?: string | null
          state?: string
          token?: string | null
          updated_at?: string
        }
        Update: {
          accepted_at?: string | null
          attempts?: number
          call_id?: string | null
          company_id?: string
          completed_at?: string | null
          created_at?: string
          error_code?: string | null
          id?: string
          job_id?: string | null
          lease_until?: string | null
          next_attempt?: string
          running_observed_at?: string | null
          state?: string
          token?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_dispatch_outbox_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: false
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_dispatch_outbox_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_dispatch_outbox_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: true
            referencedRelation: "ai_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_erasure_requests: {
        Row: {
          actor_id: string
          call_id: string | null
          company_id: string
          created_at: string
          id: string
          scope: string
          state: string
          updated_at: string
        }
        Insert: {
          actor_id: string
          call_id?: string | null
          company_id: string
          created_at?: string
          id: string
          scope: string
          state?: string
          updated_at?: string
        }
        Update: {
          actor_id?: string
          call_id?: string | null
          company_id?: string
          created_at?: string
          id?: string
          scope?: string
          state?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_erasure_requests_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: false
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_erasure_requests_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_inbox_receipts: {
        Row: {
          call_id: string
          company_id: string
          created_at: string
          result: Json
          updated_at: string
        }
        Insert: {
          call_id: string
          company_id: string
          created_at?: string
          result: Json
          updated_at?: string
        }
        Update: {
          call_id?: string
          company_id?: string
          created_at?: string
          result?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_inbox_receipts_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: false
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_inbox_receipts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_jobs: {
        Row: {
          attempts: number
          call_id: string
          company_id: string
          created_at: string
          error_code: string | null
          id: string
          lease_token: string | null
          lease_until: string | null
          run_after: string
          state: string
          step: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          call_id: string
          company_id: string
          created_at?: string
          error_code?: string | null
          id?: string
          lease_token?: string | null
          lease_until?: string | null
          run_after?: string
          state?: string
          step?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          call_id?: string
          company_id?: string
          created_at?: string
          error_code?: string | null
          id?: string
          lease_token?: string | null
          lease_until?: string | null
          run_after?: string
          state?: string
          step?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_jobs_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: false
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_monitor_counters: {
        Row: {
          company_id: string
          hour: string
          metric: string
          n: number
        }
        Insert: {
          company_id: string
          hour: string
          metric: string
          n?: number
        }
        Update: {
          company_id?: string
          hour?: string
          metric?: string
          n?: number
        }
        Relationships: [
          {
            foreignKeyName: "samtal_monitor_counters_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_monitor_platform_counters: {
        Row: {
          hour: string
          metric: string
          n: number
        }
        Insert: {
          hour: string
          metric: string
          n?: number
        }
        Update: {
          hour?: string
          metric?: string
          n?: number
        }
        Relationships: []
      }
      samtal_numbers: {
        Row: {
          active: boolean
          company_id: string
          created_at: string
          id: string
          phone_e164: string
          updated_at: string
          user_id: string
        }
        Insert: {
          active?: boolean
          company_id: string
          created_at?: string
          id?: string
          phone_e164: string
          updated_at?: string
          user_id: string
        }
        Update: {
          active?: boolean
          company_id?: string
          created_at?: string
          id?: string
          phone_e164?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_numbers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_numbers_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_members"
            referencedColumns: ["company_id", "user_id"]
          },
        ]
      }
      samtal_provider_accounts: {
        Row: {
          account_ref: string
          company_id: string
          created_at: string
          id: string
          number_id: string
          provider: string
          revoked_at: string | null
          user_id: string
          verified_at: string | null
        }
        Insert: {
          account_ref: string
          company_id: string
          created_at?: string
          id?: string
          number_id: string
          provider: string
          revoked_at?: string | null
          user_id: string
          verified_at?: string | null
        }
        Update: {
          account_ref?: string
          company_id?: string
          created_at?: string
          id?: string
          number_id?: string
          provider?: string
          revoked_at?: string | null
          user_id?: string
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "samtal_provider_accounts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_provider_accounts_company_id_number_id_fkey"
            columns: ["company_id", "number_id"]
            isOneToOne: false
            referencedRelation: "samtal_numbers"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_provider_accounts_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_members"
            referencedColumns: ["company_id", "user_id"]
          },
          {
            foreignKeyName: "samtal_provider_accounts_provider_fkey"
            columns: ["provider"]
            isOneToOne: false
            referencedRelation: "samtal_webhook_providers"
            referencedColumns: ["provider"]
          },
        ]
      }
      samtal_replay_denials: {
        Row: {
          company_id: string
          created_at: string
          event_digest: string
          expires_at: string | null
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          event_digest: string
          expires_at?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          event_digest?: string
          expires_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      samtal_reviews: {
        Row: {
          actor_id: string | null
          call_id: string
          company_id: string
          created_at: string
          decided_at: string | null
          decision: string
          request_id: string | null
          updated_at: string
        }
        Insert: {
          actor_id?: string | null
          call_id: string
          company_id: string
          created_at?: string
          decided_at?: string | null
          decision?: string
          request_id?: string | null
          updated_at?: string
        }
        Update: {
          actor_id?: string | null
          call_id?: string
          company_id?: string
          created_at?: string
          decided_at?: string | null
          decision?: string
          request_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_reviews_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: false
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_reviews_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_ring_contexts: {
        Row: {
          company_id: string
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          user_id: string
        }
        Insert: {
          company_id: string
          consumed_at?: string | null
          created_at?: string
          expires_at: string
          id?: string
          user_id: string
        }
        Update: {
          company_id?: string
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_ring_contexts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_ring_contexts_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_members"
            referencedColumns: ["company_id", "user_id"]
          },
        ]
      }
      samtal_ring_draft_tombstones: {
        Row: {
          call_id: string
          company_id: string
          deleted_at: string
          kind: string
          title_hash: string
        }
        Insert: {
          call_id: string
          company_id: string
          deleted_at?: string
          kind: string
          title_hash: string
        }
        Update: {
          call_id?: string
          company_id?: string
          deleted_at?: string
          kind?: string
          title_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_ring_draft_tombstones_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_ring_drafts: {
        Row: {
          body: Json
          call_id: string
          company_id: string
          created_at: string
          customer_id: string | null
          decided_at: string | null
          decided_by: string | null
          due_at: string | null
          due_date: string | null
          due_time_source: string | null
          edited_at: string | null
          edited_by: string | null
          id: string
          kind: string
          needs_review: boolean
          project_ref: string | null
          state: string
          title: string
          user_id: string | null
          version: number
        }
        Insert: {
          body?: Json
          call_id: string
          company_id: string
          created_at?: string
          customer_id?: string | null
          decided_at?: string | null
          decided_by?: string | null
          due_at?: string | null
          due_date?: string | null
          due_time_source?: string | null
          edited_at?: string | null
          edited_by?: string | null
          id?: string
          kind: string
          needs_review?: boolean
          project_ref?: string | null
          state?: string
          title: string
          user_id?: string | null
          version?: number
        }
        Update: {
          body?: Json
          call_id?: string
          company_id?: string
          created_at?: string
          customer_id?: string | null
          decided_at?: string | null
          decided_by?: string | null
          due_at?: string | null
          due_date?: string | null
          due_time_source?: string | null
          edited_at?: string | null
          edited_by?: string | null
          id?: string
          kind?: string
          needs_review?: boolean
          project_ref?: string | null
          state?: string
          title?: string
          user_id?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "samtal_ring_drafts_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: false
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_ring_drafts_company_id_customer_id_fkey"
            columns: ["company_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_ring_drafts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_ring_drafts_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_members"
            referencedColumns: ["company_id", "user_id"]
          },
        ]
      }
      samtal_ring_enrollments: {
        Row: {
          company_id: string
          created_at: string
          id: string
          identity_id: string | null
          phone_e164: string
          provider: string
          requested_by: string
          revoked_at: string | null
          revoked_by: string | null
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          identity_id?: string | null
          phone_e164: string
          provider: string
          requested_by: string
          revoked_at?: string | null
          revoked_by?: string | null
          state?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          identity_id?: string | null
          phone_e164?: string
          provider?: string
          requested_by?: string
          revoked_at?: string | null
          revoked_by?: string | null
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_ring_enrollments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_ring_enrollments_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_members"
            referencedColumns: ["company_id", "user_id"]
          },
          {
            foreignKeyName: "samtal_ring_enrollments_identity_id_fkey"
            columns: ["identity_id"]
            isOneToOne: false
            referencedRelation: "samtal_ring_identities"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_ring_handoffs: {
        Row: {
          attempts: number
          company_id: string
          completed_at: string | null
          customer_id: string
          draft_id: string
          draft_version: number
          error_code: string | null
          id: string
          project_ref: string | null
          quote_ref: string | null
          requested_at: string
          requested_by: string
          state: string
        }
        Insert: {
          attempts?: number
          company_id: string
          completed_at?: string | null
          customer_id: string
          draft_id: string
          draft_version: number
          error_code?: string | null
          id?: string
          project_ref?: string | null
          quote_ref?: string | null
          requested_at?: string
          requested_by: string
          state?: string
        }
        Update: {
          attempts?: number
          company_id?: string
          completed_at?: string | null
          customer_id?: string
          draft_id?: string
          draft_version?: number
          error_code?: string | null
          id?: string
          project_ref?: string | null
          quote_ref?: string | null
          requested_at?: string
          requested_by?: string
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_ring_handoffs_company_id_customer_id_fkey"
            columns: ["company_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_ring_handoffs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_ring_handoffs_draft_id_fkey"
            columns: ["draft_id"]
            isOneToOne: true
            referencedRelation: "samtal_ring_drafts"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_ring_identities: {
        Row: {
          account_ref: string
          company_id: string
          created_at: string
          evidence_kind: string
          id: string
          provider: string
          revoked_at: string | null
          user_id: string
          verified_at: string
          verified_by: string
        }
        Insert: {
          account_ref: string
          company_id: string
          created_at?: string
          evidence_kind?: string
          id?: string
          provider: string
          revoked_at?: string | null
          user_id: string
          verified_at: string
          verified_by: string
        }
        Update: {
          account_ref?: string
          company_id?: string
          created_at?: string
          evidence_kind?: string
          id?: string
          provider?: string
          revoked_at?: string | null
          user_id?: string
          verified_at?: string
          verified_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_ring_identities_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_ring_identities_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_members"
            referencedColumns: ["company_id", "user_id"]
          },
        ]
      }
      samtal_ring_pending: {
        Row: {
          assigned_call: string | null
          created_at: string
          delete_after: string
          duration_seconds: number | null
          id: string
          provider: string
          provider_call_id: string
          started_at: string
          transcript: Json
          user_id: string
        }
        Insert: {
          assigned_call?: string | null
          created_at?: string
          delete_after?: string
          duration_seconds?: number | null
          id?: string
          provider: string
          provider_call_id: string
          started_at: string
          transcript: Json
          user_id: string
        }
        Update: {
          assigned_call?: string | null
          created_at?: string
          delete_after?: string
          duration_seconds?: number | null
          id?: string
          provider?: string
          provider_call_id?: string
          started_at?: string
          transcript?: Json
          user_id?: string
        }
        Relationships: []
      }
      samtal_ring_rejections: {
        Row: {
          event_digest: string
          id: number
          reason: string
          received_at: string
        }
        Insert: {
          event_digest: string
          id?: never
          reason: string
          received_at?: string
        }
        Update: {
          event_digest?: string
          id?: never
          reason?: string
          received_at?: string
        }
        Relationships: []
      }
      samtal_ring_verification_events: {
        Row: {
          event_id: string
          provider: string
          received_at: string
          result: string
        }
        Insert: {
          event_id: string
          provider: string
          received_at?: string
          result: string
        }
        Update: {
          event_id?: string
          provider?: string
          received_at?: string
          result?: string
        }
        Relationships: []
      }
      samtal_ring_verifications: {
        Row: {
          challenge_hash: string
          company_id: string
          created_at: string
          enrollment_id: string
          expires_at: string
          id: string
          provider: string
          state: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          challenge_hash: string
          company_id: string
          created_at?: string
          enrollment_id: string
          expires_at: string
          id?: string
          provider: string
          state?: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          challenge_hash?: string
          company_id?: string
          created_at?: string
          enrollment_id?: string
          expires_at?: string
          id?: string
          provider?: string
          state?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_ring_verifications_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_ring_verifications_enrollment_id_fkey"
            columns: ["enrollment_id"]
            isOneToOne: false
            referencedRelation: "samtal_ring_enrollments"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_runtime_limits: {
        Row: {
          created_at: string
          default_tenant_dispatch: number
          default_tenant_processing: number
          dispatch_retry_budget: number
          global_dispatch: number
          global_processing: number
          id: boolean
          ingest_hourly_reservations: number
          scan_budget: number
          tenant_pending: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_tenant_dispatch?: number
          default_tenant_processing?: number
          dispatch_retry_budget?: number
          global_dispatch?: number
          global_processing?: number
          id?: boolean
          ingest_hourly_reservations?: number
          scan_budget?: number
          tenant_pending?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_tenant_dispatch?: number
          default_tenant_processing?: number
          dispatch_retry_budget?: number
          global_dispatch?: number
          global_processing?: number
          id?: boolean
          ingest_hourly_reservations?: number
          scan_budget?: number
          tenant_pending?: number
          updated_at?: string
        }
        Relationships: []
      }
      samtal_settings: {
        Row: {
          auto_process: boolean
          company_id: string
          created_at: string
          provider: string | null
          provider_error: string | null
          provider_status: string
          retention_days: number
          updated_at: string
        }
        Insert: {
          auto_process?: boolean
          company_id: string
          created_at?: string
          provider?: string | null
          provider_error?: string | null
          provider_status?: string
          retention_days?: number
          updated_at?: string
        }
        Update: {
          auto_process?: boolean
          company_id?: string
          created_at?: string
          provider?: string | null
          provider_error?: string | null
          provider_status?: string
          retention_days?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_settings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_shared_numbers: {
        Row: {
          phone_e164: string
        }
        Insert: {
          phone_e164: string
        }
        Update: {
          phone_e164?: string
        }
        Relationships: []
      }
      samtal_tasks: {
        Row: {
          address: string | null
          call_id: string
          company_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          due_at: string | null
          id: string
          kind: string
          state: string
          title: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          address?: string | null
          call_id: string
          company_id: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          due_at?: string | null
          id?: string
          kind: string
          state?: string
          title: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          address?: string | null
          call_id?: string
          company_id?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          due_at?: string | null
          id?: string
          kind?: string
          state?: string
          title?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "samtal_tasks_company_id_call_id_fkey"
            columns: ["company_id", "call_id"]
            isOneToOne: false
            referencedRelation: "samtal_calls"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "samtal_tasks_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "samtal_tasks_company_id_user_id_fkey"
            columns: ["company_id", "user_id"]
            isOneToOne: false
            referencedRelation: "company_members"
            referencedColumns: ["company_id", "user_id"]
          },
        ]
      }
      samtal_tenant_state: {
        Row: {
          cleanup_cursor: string
          company_id: string
          created_at: string
          dispatch_cursor: string
          dispatch_limit: number | null
          erasure_cursor: string | null
          legacy_inventory_verified_at: string | null
          process_cursor: string
          process_limit: number | null
          retired_at: string | null
          updated_at: string
        }
        Insert: {
          cleanup_cursor?: string
          company_id: string
          created_at?: string
          dispatch_cursor?: string
          dispatch_limit?: number | null
          erasure_cursor?: string | null
          legacy_inventory_verified_at?: string | null
          process_cursor?: string
          process_limit?: number | null
          retired_at?: string | null
          updated_at?: string
        }
        Update: {
          cleanup_cursor?: string
          company_id?: string
          created_at?: string
          dispatch_cursor?: string
          dispatch_limit?: number | null
          erasure_cursor?: string | null
          legacy_inventory_verified_at?: string | null
          process_cursor?: string
          process_limit?: number | null
          retired_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_tenant_state_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      samtal_webhook_call_leases: {
        Row: {
          lease_until: string
          provider: string
          provider_call_id: string
          token: string
        }
        Insert: {
          lease_until: string
          provider: string
          provider_call_id: string
          token: string
        }
        Update: {
          lease_until?: string
          provider?: string
          provider_call_id?: string
          token?: string
        }
        Relationships: []
      }
      samtal_webhook_events: {
        Row: {
          attempts: number
          event: Json | null
          event_id: string
          lease_token: string | null
          provider: string
          provider_call_id: string
          purge_after: string
          received_at: string
          result_code: string | null
          run_after: string
          state: string
        }
        Insert: {
          attempts?: number
          event?: Json | null
          event_id: string
          lease_token?: string | null
          provider: string
          provider_call_id: string
          purge_after: string
          received_at?: string
          result_code?: string | null
          run_after?: string
          state?: string
        }
        Update: {
          attempts?: number
          event?: Json | null
          event_id?: string
          lease_token?: string | null
          provider?: string
          provider_call_id?: string
          purge_after?: string
          received_at?: string
          result_code?: string | null
          run_after?: string
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "samtal_webhook_events_provider_fkey"
            columns: ["provider"]
            isOneToOne: false
            referencedRelation: "samtal_webhook_providers"
            referencedColumns: ["provider"]
          },
        ]
      }
      samtal_webhook_providers: {
        Row: {
          max_attempts: number
          max_pending: number
          per_minute: number
          provider: string
          replay_seconds: number
          retention_hours: number
        }
        Insert: {
          max_attempts?: number
          max_pending?: number
          per_minute?: number
          provider: string
          replay_seconds?: number
          retention_hours?: number
        }
        Update: {
          max_attempts?: number
          max_pending?: number
          per_minute?: number
          provider?: string
          replay_seconds?: number
          retention_hours?: number
        }
        Relationships: []
      }
      samtal_webhook_rate: {
        Row: {
          hits: number
          provider: string
          window_start: string
        }
        Insert: {
          hits: number
          provider: string
          window_start: string
        }
        Update: {
          hits?: number
          provider?: string
          window_start?: string
        }
        Relationships: []
      }
      samtal_webhook_replays: {
        Row: {
          claim_until: string
          expires_at: string
          provider: string
          replay_key: string
          state: string
        }
        Insert: {
          claim_until: string
          expires_at: string
          provider: string
          replay_key: string
          state: string
        }
        Update: {
          claim_until?: string
          expires_at?: string
          provider?: string
          replay_key?: string
          state?: string
        }
        Relationships: []
      }
      tender_calculation_matches: {
        Row: {
          analysis_run: string
          company_id: string
          created_at: string
          result: Json
          tender_id: string
          updated_at: string
        }
        Insert: {
          analysis_run: string
          company_id: string
          created_at?: string
          result: Json
          tender_id: string
          updated_at?: string
        }
        Update: {
          analysis_run?: string
          company_id?: string
          created_at?: string
          result?: Json
          tender_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tender_calculation_matches_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tender_calculation_matches_tender_id_analysis_run_fkey"
            columns: ["tender_id", "analysis_run"]
            isOneToOne: false
            referencedRelation: "tender_quantities"
            referencedColumns: ["tender_id", "analysis_run"]
          },
        ]
      }
      tender_calculation_settings: {
        Row: {
          company_id: string
          contingency: number
          created_at: string
          establishment: number
          example_values: boolean
          hourly_rate: number
          list_discount: number
          material_markup: number
          post_types: Json
          room_recipes: Json | null
          updated_at: string
        }
        Insert: {
          company_id: string
          contingency?: number
          created_at?: string
          establishment?: number
          example_values?: boolean
          hourly_rate?: number
          list_discount?: number
          material_markup?: number
          post_types?: Json
          room_recipes?: Json | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          contingency?: number
          created_at?: string
          establishment?: number
          example_values?: boolean
          hourly_rate?: number
          list_discount?: number
          material_markup?: number
          post_types?: Json
          room_recipes?: Json | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tender_calculation_settings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      tender_documents: {
        Row: {
          analysis_status: string
          company_id: string
          content_hash: string | null
          created_at: string
          doc_type: string | null
          error: string | null
          file_name: string
          file_type: string
          id: string
          page_count: number | null
          path: string
          size: number
          summary: string | null
          tender_id: string
          updated_at: string
        }
        Insert: {
          analysis_status?: string
          company_id: string
          content_hash?: string | null
          created_at?: string
          doc_type?: string | null
          error?: string | null
          file_name: string
          file_type: string
          id?: string
          page_count?: number | null
          path: string
          size: number
          summary?: string | null
          tender_id: string
          updated_at?: string
        }
        Update: {
          analysis_status?: string
          company_id?: string
          content_hash?: string | null
          created_at?: string
          doc_type?: string | null
          error?: string | null
          file_name?: string
          file_type?: string
          id?: string
          page_count?: number | null
          path?: string
          size?: number
          summary?: string | null
          tender_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tender_documents_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tender_documents_tender_id_company_id_fkey"
            columns: ["tender_id", "company_id"]
            isOneToOne: false
            referencedRelation: "tenders"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      tender_file_cache: {
        Row: {
          company_id: string
          content_hash: string
          created_at: string
          part: number
          reading_version: string
          result: Json
          updated_at: string
        }
        Insert: {
          company_id: string
          content_hash: string
          created_at?: string
          part: number
          reading_version: string
          result: Json
          updated_at?: string
        }
        Update: {
          company_id?: string
          content_hash?: string
          created_at?: string
          part?: number
          reading_version?: string
          result?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tender_file_cache_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      tender_insights: {
        Row: {
          analysis_run: string
          company_id: string
          created_at: string
          error: string | null
          result: Json | null
          status: string
          steps: Json
          tender_id: string
          updated_at: string
        }
        Insert: {
          analysis_run: string
          company_id: string
          created_at?: string
          error?: string | null
          result?: Json | null
          status: string
          steps?: Json
          tender_id: string
          updated_at?: string
        }
        Update: {
          analysis_run?: string
          company_id?: string
          created_at?: string
          error?: string | null
          result?: Json | null
          status?: string
          steps?: Json
          tender_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tender_insights_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tender_insights_tender_id_fkey"
            columns: ["tender_id"]
            isOneToOne: true
            referencedRelation: "tenders"
            referencedColumns: ["id"]
          },
        ]
      }
      tender_job_secrets: {
        Row: {
          base_url: string | null
          created_at: string
          tender_id: string
          token: string
          updated_at: string
        }
        Insert: {
          base_url?: string | null
          created_at?: string
          tender_id: string
          token: string
          updated_at?: string
        }
        Update: {
          base_url?: string | null
          created_at?: string
          tender_id?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tender_job_secrets_tender_id_fkey"
            columns: ["tender_id"]
            isOneToOne: true
            referencedRelation: "tender_jobs"
            referencedColumns: ["tender_id"]
          },
        ]
      }
      tender_jobs: {
        Row: {
          analysis_run: string
          company_id: string
          created_at: string
          error: string | null
          failed_step: string | null
          hops: number
          kicked_at: string | null
          lease_until: string | null
          parts: Json
          plan: Json
          status: string
          steps: Json
          tender_id: string
          updated_at: string
        }
        Insert: {
          analysis_run: string
          company_id: string
          created_at?: string
          error?: string | null
          failed_step?: string | null
          hops?: number
          kicked_at?: string | null
          lease_until?: string | null
          parts?: Json
          plan?: Json
          status: string
          steps?: Json
          tender_id: string
          updated_at?: string
        }
        Update: {
          analysis_run?: string
          company_id?: string
          created_at?: string
          error?: string | null
          failed_step?: string | null
          hops?: number
          kicked_at?: string | null
          lease_until?: string | null
          parts?: Json
          plan?: Json
          status?: string
          steps?: Json
          tender_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tender_jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tender_jobs_tender_id_fkey"
            columns: ["tender_id"]
            isOneToOne: true
            referencedRelation: "tenders"
            referencedColumns: ["id"]
          },
        ]
      }
      tender_quantities: {
        Row: {
          analysis_run: string
          company_id: string
          created_at: string
          error: string | null
          result: Json | null
          status: string
          tender_id: string
          updated_at: string
        }
        Insert: {
          analysis_run: string
          company_id: string
          created_at?: string
          error?: string | null
          result?: Json | null
          status: string
          tender_id: string
          updated_at?: string
        }
        Update: {
          analysis_run?: string
          company_id?: string
          created_at?: string
          error?: string | null
          result?: Json | null
          status?: string
          tender_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tender_quantities_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tender_quantities_tender_id_fkey"
            columns: ["tender_id"]
            isOneToOne: true
            referencedRelation: "tenders"
            referencedColumns: ["id"]
          },
        ]
      }
      tender_result_cache: {
        Row: {
          company_id: string
          created_at: string
          fingerprint: string
          result: Json
          step: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          fingerprint: string
          result: Json
          step: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          fingerprint?: string
          result?: Json
          step?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tender_result_cache_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      tender_watch_hits: {
        Row: {
          buyer: string
          city: string | null
          company_id: string
          cpv: string[]
          created_at: string
          currency: string | null
          deadline: string | null
          documents_url: string | null
          framework: boolean
          id: string
          kind: string
          notice_url: string
          places: string[]
          publication_number: string
          published: string
          status: string
          tender_id: string | null
          title: string
          value: number | null
        }
        Insert: {
          buyer: string
          city?: string | null
          company_id?: string
          cpv?: string[]
          created_at?: string
          currency?: string | null
          deadline?: string | null
          documents_url?: string | null
          framework?: boolean
          id?: string
          kind: string
          notice_url: string
          places?: string[]
          publication_number: string
          published: string
          status?: string
          tender_id?: string | null
          title: string
          value?: number | null
        }
        Update: {
          buyer?: string
          city?: string | null
          company_id?: string
          cpv?: string[]
          created_at?: string
          currency?: string | null
          deadline?: string | null
          documents_url?: string | null
          framework?: boolean
          id?: string
          kind?: string
          notice_url?: string
          places?: string[]
          publication_number?: string
          published?: string
          status?: string
          tender_id?: string | null
          title?: string
          value?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "tender_watch_hits_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tender_watch_hits_tender_id_fkey"
            columns: ["tender_id"]
            isOneToOne: false
            referencedRelation: "tenders"
            referencedColumns: ["id"]
          },
        ]
      }
      tender_watch_profiles: {
        Row: {
          company_id: string
          last_fetched_at: string | null
          regions: string[]
          updated_at: string
        }
        Insert: {
          company_id?: string
          last_fetched_at?: string | null
          regions?: string[]
          updated_at?: string
        }
        Update: {
          company_id?: string
          last_fetched_at?: string | null
          regions?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tender_watch_profiles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      tenders: {
        Row: {
          analysis_run: string | null
          analysis_started_at: string | null
          company_id: string
          created_at: string
          error: string | null
          id: string
          name: string
          reading_version: string
          status: string
          updated_at: string
        }
        Insert: {
          analysis_run?: string | null
          analysis_started_at?: string | null
          company_id: string
          created_at?: string
          error?: string | null
          id?: string
          name: string
          reading_version?: string
          status?: string
          updated_at?: string
        }
        Update: {
          analysis_run?: string | null
          analysis_started_at?: string | null
          company_id?: string
          created_at?: string
          error?: string | null
          id?: string
          name?: string
          reading_version?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenders_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      threads: {
        Row: {
          asks: Json
          autopilot: boolean
          channel: string
          company_id: string
          created_at: string
          customer_id: string
          facts: Json
          id: string
          interpretation: Json | null
          job: string
          last_customer_wa_at: string | null
          last_message_at: string
          pending_sender: Json | null
          place: string | null
          read: boolean
          status: string
          suggested_merge_thread_id: string | null
          updated_at: string
          whatsapp_auto_override: boolean | null
          why: string
        }
        Insert: {
          asks?: Json
          autopilot?: boolean
          channel: string
          company_id: string
          created_at?: string
          customer_id: string
          facts?: Json
          id?: string
          interpretation?: Json | null
          job: string
          last_customer_wa_at?: string | null
          last_message_at?: string
          pending_sender?: Json | null
          place?: string | null
          read?: boolean
          status?: string
          suggested_merge_thread_id?: string | null
          updated_at?: string
          whatsapp_auto_override?: boolean | null
          why?: string
        }
        Update: {
          asks?: Json
          autopilot?: boolean
          channel?: string
          company_id?: string
          created_at?: string
          customer_id?: string
          facts?: Json
          id?: string
          interpretation?: Json | null
          job?: string
          last_customer_wa_at?: string | null
          last_message_at?: string
          pending_sender?: Json | null
          place?: string | null
          read?: boolean
          status?: string
          suggested_merge_thread_id?: string | null
          updated_at?: string
          whatsapp_auto_override?: boolean | null
          why?: string
        }
        Relationships: [
          {
            foreignKeyName: "threads_company_id_customer_id_fkey"
            columns: ["company_id", "customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["company_id", "id"]
          },
          {
            foreignKeyName: "threads_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "threads_suggested_merge_thread_id_fkey"
            columns: ["suggested_merge_thread_id"]
            isOneToOne: false
            referencedRelation: "threads"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      estim_abort_tender_analysis: {
        Args: { failure: string; rid: string; tid: string }
        Returns: undefined
      }
      estim_accept_invitation: {
        Args: {
          display: string
          expected_hash: string
          iid: string
          uid: string
        }
        Returns: string
      }
      estim_approve: { Args: { tid: string }; Returns: string }
      estim_approve_email_sender: {
        Args: {
          edited_email?: string
          edited_name?: string
          edited_phone?: string
          tid: string
          use_customer_id?: string
        }
        Returns: Json
      }
      estim_begin_tender_analysis: { Args: { tid: string }; Returns: string }
      estim_claim_job: { Args: { jid: string }; Returns: boolean }
      estim_claim_tender_document: {
        Args: { did: string; rid: string }
        Returns: boolean
      }
      estim_claim_tender_insights: {
        Args: { rid: string; tid: string }
        Returns: boolean
      }
      estim_claim_tender_job: {
        Args: { p_token: string; tid: string }
        Returns: Json
      }
      estim_claim_tender_quantities: {
        Args: { rid: string; tid: string }
        Returns: boolean
      }
      estim_company_active: { Args: { cid: string }; Returns: boolean }
      estim_complete_tender: {
        Args: { files: Json; tid: string }
        Returns: undefined
      }
      estim_document_requested: {
        Args: {
          doc_name: string
          doc_type: string
          prior: boolean
          txt: string
        }
        Returns: boolean
      }
      estim_email_connection: { Args: never; Returns: Json }
      estim_email_grant_state: {
        Args: { new_state: string; p_grant: string }
        Returns: undefined
      }
      estim_email_status: {
        Args: {
          err?: string
          new_status: string
          p_grant: string
          p_msg: string
        }
        Returns: undefined
      }
      estim_finish_send: {
        Args: {
          delivered: boolean
          failure?: string
          mid: string
          provider_id?: string
        }
        Returns: undefined
      }
      estim_finish_tender_document: {
        Args: { did: string; result: Json; rid: string }
        Returns: undefined
      }
      estim_finish_tender_insights: {
        Args: { p_error: string; p_result: Json; rid: string; tid: string }
        Returns: undefined
      }
      estim_finish_tender_quantities: {
        Args: { p_error: string; p_result: Json; rid: string; tid: string }
        Returns: undefined
      }
      estim_import_prices: { Args: { payload: Json }; Returns: number }
      estim_job_quote: {
        Args: { cid: string; payload: Json; tid: string }
        Returns: number
      }
      estim_kick_tender_job: { Args: { tid: string }; Returns: boolean }
      estim_login_begin: { Args: { h: string }; Returns: string }
      estim_login_finish: {
        Args: {
          email_address: string
          h: string
          lease: string
          success: boolean
        }
        Returns: undefined
      }
      estim_manage_member: {
        Args: { actor: string; cid: string; new_role: string; uid: string }
        Returns: undefined
      }
      estim_merge_customers: {
        Args: { drop_id: string; keep_id: string }
        Returns: string
      }
      estim_merge_email_thread: {
        Args: { source_tid: string; target_tid: string }
        Returns: Json
      }
      estim_norm_phone: { Args: { p: string }; Returns: string }
      estim_onboard: { Args: { payload: Json }; Returns: string }
      estim_prepare_auto_send: { Args: { jid: string }; Returns: string }
      estim_prepare_send: { Args: { tid: string }; Returns: string }
      estim_quote: { Args: { payload: Json; tid: string }; Returns: number }
      estim_recalculate_tender_job: {
        Args: { p_base_url: string; p_company_id: string; tid: string }
        Returns: string
      }
      estim_receive: {
        Args: { actor?: string; cid: string; payload: Json }
        Returns: Json
      }
      estim_receive_email: {
        Args: { cid: string; payload: Json }
        Returns: Json
      }
      estim_request: { Args: { payload: Json }; Returns: string }
      estim_reread_tender_job: {
        Args: { p_base_url: string; p_company_id: string; tid: string }
        Returns: string
      }
      estim_rerun_tender_risks: {
        Args: { p_base_url: string; p_company_id: string; tid: string }
        Returns: string
      }
      estim_revoke_invitation: {
        Args: { actor: string; cid: string; iid: string }
        Returns: undefined
      }
      estim_save_invitation: {
        Args: {
          actor: string
          cid: string
          expiry: string
          hashed: string
          invited_role: string
          previous_id?: string
          recipient: string
        }
        Returns: string
      }
      estim_save_tender_insight_step: {
        Args: { p_step: string; p_value: Json; rid: string; tid: string }
        Returns: undefined
      }
      estim_session_valid: { Args: never; Returns: boolean }
      estim_set_won: { Args: { tid: string; won: boolean }; Returns: string }
      estim_split_thread: { Args: { mid: string; tid: string }; Returns: Json }
      estim_start_tender_job: {
        Args: { p_base_url: string; p_resume: boolean; tid: string }
        Returns: string
      }
      my_company: { Args: never; Returns: string }
      samtal_a10_commit_quote: {
        Args: {
          p_call: string
          p_company: string
          p_expected_quote: string
          p_lines: Json
          p_mode: string
          p_version: number
        }
        Returns: Json
      }
      samtal_a10_handoff: {
        Args: {
          p_actor?: string
          p_assignment: string
          p_call: string
          p_company: string
          p_create: boolean
          p_customer: string
          p_identity: Json
          p_job?: string
          p_request: string
          p_title: string
          p_token?: string
          p_version: number
        }
        Returns: Json
      }
      samtal_a9_assignments: {
        Args: {
          p_call: string
          p_company: string
          p_customer: string
          p_job: string
          p_token: string
        }
        Returns: Json
      }
      samtal_a9_candidates: {
        Args: {
          p_address: string
          p_call: string
          p_company: string
          p_job: string
          p_name: string
          p_phone: string
          p_token: string
        }
        Returns: Json
      }
      samtal_a9_commit_quote: {
        Args: {
          p_call: string
          p_company: string
          p_expected_quote: string
          p_expected_version: number
          p_lines: Json
        }
        Returns: Json
      }
      samtal_a9_confirm: {
        Args: {
          p_actor: string
          p_assignment: string
          p_call: string
          p_company: string
          p_customer: string
          p_expected_version: number
          p_request: string
        }
        Returns: Json
      }
      samtal_a9_phone: { Args: { v: string }; Returns: string }
      samtal_a9_review_options: {
        Args: {
          p_actor: string
          p_call: string
          p_company: string
          p_customer?: string
        }
        Returns: Json
      }
      samtal_a9_ring_stage: {
        Args: {
          p_call: string
          p_company: string
          p_extraction: Json
          p_job: string
          p_token: string
          p_transcript: Json
        }
        Returns: boolean
      }
      samtal_a9_save: {
        Args: {
          p_assignment: Json
          p_call: string
          p_company: string
          p_customer: Json
          p_job: string
          p_token: string
        }
        Returns: Json
      }
      samtal_a9_text: { Args: { v: string }; Returns: string }
      samtal_alert_evaluate: {
        Args: { p_company: string; p_cooldown_minutes?: number }
        Returns: number
      }
      samtal_audio_access_guarded: {
        Args: { p_actor: string; p_call: string; p_company: string }
        Returns: string
      }
      samtal_begin_delete: {
        Args: { p_call: string; p_company: string; p_reason: string }
        Returns: boolean
      }
      samtal_bind_provider_call: {
        Args: {
          p_account_ref?: string
          p_business_number?: string
          p_call: string
          p_direction: string
          p_provider: string
          p_recording_id?: string
        }
        Returns: Json
      }
      samtal_certify_legacy_inventory: {
        Args: { p_company: string; p_evidence: string }
        Returns: boolean
      }
      samtal_certify_writer_closed: {
        Args: { p_audio: string; p_company: string; p_evidence: string }
        Returns: boolean
      }
      samtal_claim_cleanup: {
        Args: { p_lease_seconds: number; p_limit: number }
        Returns: {
          attempts: number
          audio_path: string
          call_id: string | null
          cleanup_token: string | null
          cleanup_until: string | null
          closure_evidence: string | null
          company_id: string
          created_at: string
          error_code: string | null
          id: string
          queue: string
          retire_after: string | null
          retry_after: string
          state: string
          updated_at: string
          upload_token: string
          upload_until: string
          verification_count: number
          verified_at: string | null
          writer_closed_at: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "samtal_audio_ledger"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      samtal_claim_cleanup_class: {
        Args: { p_lease_seconds: number; p_limit: number; p_queue: string }
        Returns: {
          attempts: number
          audio_path: string
          call_id: string | null
          cleanup_token: string | null
          cleanup_until: string | null
          closure_evidence: string | null
          company_id: string
          created_at: string
          error_code: string | null
          id: string
          queue: string
          retire_after: string | null
          retry_after: string
          state: string
          updated_at: string
          upload_token: string
          upload_until: string
          verification_count: number
          verified_at: string | null
          writer_closed_at: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "samtal_audio_ledger"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      samtal_claim_dispatch: {
        Args: { p_lease_seconds: number; p_limit: number }
        Returns: {
          accepted_at: string | null
          attempts: number
          call_id: string | null
          company_id: string
          completed_at: string | null
          created_at: string
          error_code: string | null
          id: string
          job_id: string | null
          lease_until: string | null
          next_attempt: string
          running_observed_at: string | null
          state: string
          token: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "samtal_dispatch_outbox"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      samtal_claim_jobs: {
        Args: { p_lease_seconds: number; p_limit: number }
        Returns: {
          attempts: number
          call_id: string
          company_id: string
          created_at: string
          error_code: string | null
          id: string
          lease_token: string | null
          lease_until: string | null
          run_after: string
          state: string
          step: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "samtal_jobs"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      samtal_commit_private: {
        Args: {
          p_call: string
          p_company: string
          p_job: string
          p_token: string
        }
        Returns: boolean
      }
      samtal_configure_tenant_limits: {
        Args: {
          p_actor: string
          p_company: string
          p_dispatch: number
          p_processing: number
        }
        Returns: boolean
      }
      samtal_confirm_review: {
        Args: {
          p_actor: string
          p_call: string
          p_company: string
          p_decision: string
          p_request: string
        }
        Returns: boolean
      }
      samtal_decide_task: {
        Args: { p_decision: string; p_task: string }
        Returns: {
          address: string | null
          call_id: string
          company_id: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          due_at: string | null
          id: string
          kind: string
          state: string
          title: string
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "samtal_tasks"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      samtal_dispatch_live: {
        Args: { p_company: string; p_outbox: string; p_token: string }
        Returns: boolean
      }
      samtal_due_for_deletion: {
        Args: { p_limit: number }
        Returns: {
          audio_path: string
          call_id: string
          company_id: string
        }[]
      }
      samtal_erase_batch: {
        Args: { p_company: string; p_limit: number }
        Returns: number
      }
      samtal_finish_audio: {
        Args: {
          p_audio: string
          p_call: string
          p_company: string
          p_token: string
          p_uploaded: boolean
        }
        Returns: boolean
      }
      samtal_finish_cleanup: {
        Args: {
          p_audio: string
          p_company: string
          p_removed: boolean
          p_token: string
        }
        Returns: boolean
      }
      samtal_finish_dispatch: {
        Args: {
          p_accepted: boolean
          p_company: string
          p_outbox: string
          p_retry_seconds: number
          p_token: string
        }
        Returns: boolean
      }
      samtal_inbox_guarded: {
        Args: {
          p_call: string
          p_company: string
          p_extraction: Json
          p_job: string
          p_summary: string
          p_tasks: Json
          p_title: string
          p_token: string
        }
        Returns: Json
      }
      samtal_ingest_recover: {
        Args: { p_extension: string; p_request: string; payload: Json }
        Returns: Json
      }
      samtal_ingest_transcript: {
        Args: { p_transcript: Json; payload: Json }
        Returns: Json
      }
      samtal_is_owner: { Args: never; Returns: boolean }
      samtal_mark_deleted: {
        Args: { p_call: string; p_company: string }
        Returns: boolean
      }
      samtal_monitor_bump: {
        Args: { p_company: string; p_metric: string; p_n?: number }
        Returns: undefined
      }
      samtal_monitor_bump_safe: {
        Args: { p_company: string; p_metric: string }
        Returns: undefined
      }
      samtal_monitor_company: {
        Args: { p_actor: string; p_company: string }
        Returns: Json
      }
      samtal_monitor_completion: {
        Args: { p_call: string; p_company: string }
        Returns: string
      }
      samtal_monitor_platform: { Args: { p_actor: string }; Returns: Json }
      samtal_monitor_prune: { Args: { p_batch?: number }; Returns: Json }
      samtal_monitor_snapshot: {
        Args: { p_cap?: number; p_company: string }
        Returns: Json
      }
      samtal_observe_dispatch: {
        Args: { p_company: string; p_limit: number }
        Returns: number
      }
      samtal_purge_secret_valid: {
        Args: { p_secret: string }
        Returns: boolean
      }
      samtal_recover_expired: {
        Args: {
          p_limit?: number
          p_max_attempts?: number
          p_per_company?: number
        }
        Returns: Json
      }
      samtal_register_call: { Args: { payload: Json }; Returns: Json }
      samtal_release_job: {
        Args: {
          p_error: string
          p_job: string
          p_retry_seconds: number
          p_state: string
          p_step: string
          p_token: string
        }
        Returns: boolean
      }
      samtal_request_erasure: {
        Args: {
          p_actor: string
          p_call: string
          p_company: string
          p_request: string
        }
        Returns: boolean
      }
      samtal_reserve_audio: {
        Args: {
          p_call: string
          p_company: string
          p_extension: string
          p_request: string
        }
        Returns: {
          attempts: number
          audio_path: string
          call_id: string | null
          cleanup_token: string | null
          cleanup_until: string | null
          closure_evidence: string | null
          company_id: string
          created_at: string
          error_code: string | null
          id: string
          queue: string
          retire_after: string | null
          retry_after: string
          state: string
          updated_at: string
          upload_token: string
          upload_until: string
          verification_count: number
          verified_at: string | null
          writer_closed_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "samtal_audio_ledger"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      samtal_restart_guarded: {
        Args: { p_actor: string; p_call: string; p_company: string }
        Returns: boolean
      }
      samtal_retire_ledger: {
        Args: { p_company: string; p_limit: number }
        Returns: number
      }
      samtal_retry_guarded: {
        Args: {
          p_call: string
          p_company: string
          p_error: string
          p_job: string
          p_retry_seconds: number
          p_token: string
        }
        Returns: boolean
      }
      samtal_ring_apply_verification: {
        Args: {
          p_account_ref: string
          p_challenge_hash: string
          p_event_id: string
          p_evidence_kind: string
          p_provider: string
        }
        Returns: Json
      }
      samtal_ring_assign: {
        Args: { p_actor: string; p_company: string; p_pending: string }
        Returns: Json
      }
      samtal_ring_claim_handoff: { Args: { p_handoff: string }; Returns: Json }
      samtal_ring_commit: {
        Args: {
          p_call: string
          p_company: string
          p_customer: string
          p_drafts: Json
          p_extraction: Json
          p_job: string
          p_token: string
          p_transcript: Json
        }
        Returns: boolean
      }
      samtal_ring_create_call: {
        Args: { p_company: string; p_user: string; payload: Json }
        Returns: {
          audio_path: string | null
          caller_phone: string | null
          classification: string | null
          company_id: string
          content_deleted_at: string | null
          created_at: string
          customer_id: string | null
          delete_after: string
          duration_seconds: number | null
          ended_at: string | null
          error_code: string | null
          extraction: Json | null
          id: string
          kind: string
          number_id: string | null
          provider: string
          provider_call_id: string
          safety_version: number
          started_at: string
          status: string
          thread_id: string | null
          transcript: Json | null
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "samtal_calls"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      samtal_ring_decide: {
        Args: {
          p_action: string
          p_actor: string
          p_draft: string
          p_expected_version: number
          p_value?: Json
        }
        Returns: Json
      }
      samtal_ring_delete_draft: {
        Args: { p_actor: string; p_draft: string }
        Returns: Json
      }
      samtal_ring_enroll: {
        Args: {
          p_actor: string
          p_company: string
          p_phone: string
          p_provider: string
          p_user: string
        }
        Returns: Json
      }
      samtal_ring_enrollments_for: {
        Args: { p_actor: string; p_company: string }
        Returns: {
          created_at: string
          id: string
          phone_e164: string
          provider: string
          state: string
          user_id: string
        }[]
      }
      samtal_ring_finish_handoff: {
        Args: { p_error: string; p_handoff: string; p_quote_ref: string }
        Returns: Json
      }
      samtal_ring_ingest: {
        Args: {
          p_account_verified: boolean
          p_extension: string
          p_request: string
          p_transcript: Json
          payload: Json
        }
        Returns: Json
      }
      samtal_ring_is_owner: {
        Args: { p_actor: string; p_company: string }
        Returns: boolean
      }
      samtal_ring_may_act: {
        Args: {
          d: Database["public"]["Tables"]["samtal_ring_drafts"]["Row"]
          p_actor: string
        }
        Returns: boolean
      }
      samtal_ring_pending_for: {
        Args: { p_actor: string }
        Returns: {
          companies: string[]
          id: string
          started_at: string
        }[]
      }
      samtal_ring_purge_pending: { Args: { p_limit: number }; Returns: number }
      samtal_ring_reject: {
        Args: { p_digest: string; p_reason: string }
        Returns: Json
      }
      samtal_ring_request_handoff: {
        Args: { p_actor: string; p_draft: string; p_expected_version: number }
        Returns: Json
      }
      samtal_ring_resolve: {
        Args: {
          p_account_ref: string
          p_account_verified: boolean
          p_provider: string
        }
        Returns: Json
      }
      samtal_ring_revoke_enrollment: {
        Args: { p_actor: string; p_enrollment: string }
        Returns: Json
      }
      samtal_ring_set_context: {
        Args: { p_actor: string; p_company: string }
        Returns: boolean
      }
      samtal_ring_start_verification: {
        Args: {
          p_actor: string
          p_challenge_hash: string
          p_enrollment: string
          p_ttl_minutes?: number
        }
        Returns: Json
      }
      samtal_ring_title_hash: { Args: { t: string }; Returns: string }
      samtal_ring_valid_patch: {
        Args: {
          d: Database["public"]["Tables"]["samtal_ring_drafts"]["Row"]
          p: Json
        }
        Returns: boolean
      }
      samtal_ring_verify_enrollment: {
        Args: {
          p_account_ref: string
          p_enrollment: string
          p_evidence_verified: boolean
          p_provider: string
        }
        Returns: Json
      }
      samtal_safety_live: {
        Args: {
          p_call: string
          p_company: string
          p_job: string
          p_token: string
        }
        Returns: boolean
      }
      samtal_safety_lock: {
        Args: { p_call: string; p_company: string }
        Returns: {
          audio_path: string | null
          caller_phone: string | null
          classification: string | null
          company_id: string
          content_deleted_at: string | null
          created_at: string
          customer_id: string | null
          delete_after: string
          duration_seconds: number | null
          ended_at: string | null
          error_code: string | null
          extraction: Json | null
          id: string
          kind: string
          number_id: string | null
          provider: string
          provider_call_id: string
          safety_version: number
          started_at: string
          status: string
          thread_id: string | null
          transcript: Json | null
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "samtal_calls"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      samtal_track_orphan: {
        Args: { p_company: string; p_path: string }
        Returns: string
      }
      samtal_v2_deadline: { Args: { p_until: string }; Returns: undefined }
      samtal_v2_inbox_core: {
        Args: {
          p_call: string
          p_company: string
          p_extraction: Json
          p_job: string
          p_summary: string
          p_tasks: Json
          p_title: string
          p_token: string
        }
        Returns: Json
      }
      samtal_v2_try_tenant: { Args: { p_company: string }; Returns: boolean }
      samtal_webhook_accept: {
        Args: { p_events: Json; p_provider: string; p_replay_key: string }
        Returns: Json
      }
      samtal_webhook_admit: {
        Args: { p_provider: string; p_replay_key: string }
        Returns: Json
      }
      samtal_webhook_claim: {
        Args: { p_lease_seconds: number; p_limit: number }
        Returns: {
          events: Json
          provider: string
          provider_call_id: string
          token: string
        }[]
      }
      samtal_webhook_finish: {
        Args: {
          p_call: string
          p_code: string
          p_outcome: string
          p_provider: string
          p_retry_seconds?: number
          p_token: string
        }
        Returns: boolean
      }
      samtal_webhook_purge: { Args: never; Returns: Json }
      samtal_webhook_recording: {
        Args: {
          p_call: string
          p_company: string
          p_provider: string
          p_token: string
        }
        Returns: Json
      }
      samtal_webhook_release: {
        Args: { p_provider: string; p_replay_key: string }
        Returns: boolean
      }
      samtal_write_stage: {
        Args: {
          p_call: string
          p_company: string
          p_job: string
          p_stage: string
          p_token: string
          p_value: Json
        }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
