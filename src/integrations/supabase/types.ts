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
          place: string | null
          read: boolean
          status: string
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
          place?: string | null
          read?: boolean
          status?: string
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
          place?: string | null
          read?: boolean
          status?: string
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
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
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
      estim_claim_job: { Args: { jid: string }; Returns: boolean }
      estim_company_active: { Args: { cid: string }; Returns: boolean }
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
      estim_import_prices: { Args: { payload: Json }; Returns: number }
      estim_job_quote: {
        Args: { cid: string; payload: Json; tid: string }
        Returns: number
      }
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
      estim_onboard: { Args: { payload: Json }; Returns: string }
      estim_prepare_auto_send: { Args: { jid: string }; Returns: string }
      estim_prepare_send: { Args: { tid: string }; Returns: string }
      estim_quote: { Args: { payload: Json; tid: string }; Returns: number }
      estim_receive: {
        Args: { actor?: string; cid: string; payload: Json }
        Returns: Json
      }
      estim_request: { Args: { payload: Json }; Returns: string }
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
      estim_session_valid: { Args: never; Returns: boolean }
      my_company: { Args: never; Returns: string }
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
