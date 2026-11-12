// The shape of the database, so the code is checked against the real tables.
// Keep in step with supabase/migrations. (Supabase can also generate this file:
// `npx supabase gen types typescript`.)

export type PreferenceColumn =
  | "food_likes"
  | "food_dislikes"
  | "dietary_needs"
  | "tour_style"
  | "pace"
  | "interests"
  | "things_to_avoid"
  | "preferred_airlines"
  | "preferred_hotels"
  | "preferred_tour_companies"
  | "accessibility_needs";

export type ProfileRow = { user_id: string; created_at: string; updated_at: string } & Record<
  PreferenceColumn,
  string | null
>;

type MessageUsageRow = { user_id: string; day: string; count: number };

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfileRow;
        Insert: Partial<ProfileRow> & { user_id: string };
        Update: Partial<ProfileRow>;
        Relationships: [];
      };
      message_usage: {
        Row: MessageUsageRow;
        Insert: Partial<MessageUsageRow> & { user_id: string };
        Update: Partial<MessageUsageRow>;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      use_message: {
        Args: { daily_limit: number };
        Returns: { allowed: boolean; used: number }[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
