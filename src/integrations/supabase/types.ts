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
      audit_log: {
        Row: {
          actor_name: string
          after: Json | null
          approved_name: string
          before: Json | null
          company_id: string
          created_at: string
          event: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          actor_name?: string
          after?: Json | null
          approved_name?: string
          before?: Json | null
          company_id: string
          created_at?: string
          event: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          actor_name?: string
          after?: Json | null
          approved_name?: string
          before?: Json | null
          company_id?: string
          created_at?: string
          event?: string
          id?: string
          updated_at?: string
          user_id?: string
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
          reply_to_email: string | null
          settings: Json
          signature: string
          travel_fee: number
          updated_at: string
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
          reply_to_email?: string | null
          settings?: Json
          signature?: string
          travel_fee?: number
          updated_at?: string
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
          reply_to_email?: string | null
          settings?: Json
          signature?: string
          travel_fee?: number
          updated_at?: string
        }
        Relationships: []
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
      messages: {
        Row: {
          approved_by: string | null
          attachments: Json
          channel: string | null
          company_id: string
          created_at: string
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
          attachments?: Json
          channel?: string | null
          company_id: string
          created_at?: string
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
          attachments?: Json
          channel?: string | null
          company_id?: string
          created_at?: string
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
          job: string
          last_message_at: string
          place: string | null
          read: boolean
          status: string
          updated_at: string
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
          job: string
          last_message_at?: string
          place?: string | null
          read?: boolean
          status?: string
          updated_at?: string
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
          job?: string
          last_message_at?: string
          place?: string | null
          read?: boolean
          status?: string
          updated_at?: string
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
      estim_company_active: { Args: { cid: string }; Returns: boolean }
      estim_manage_member: {
        Args: { actor: string; cid: string; new_role: string; uid: string }
        Returns: undefined
      }
      estim_onboard: { Args: { payload: Json }; Returns: string }
      estim_quote: { Args: { payload: Json; tid: string }; Returns: number }
      estim_request: { Args: { payload: Json }; Returns: string }
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
