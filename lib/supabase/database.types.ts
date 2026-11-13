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

export type TripRow = {
  id: string;
  user_id: string;
  title: string;
  title_set_by_user: boolean;
  summary: string | null;
  itinerary: string | null;
  created_at: string;
  updated_at: string;
};

export type TripMessageRow = {
  id: number;
  trip_id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

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
      trips: {
        Row: TripRow;
        Insert: Partial<TripRow>;
        Update: Partial<TripRow>;
        Relationships: [];
      };
      trip_messages: {
        Row: TripMessageRow;
        Insert: Omit<Partial<TripMessageRow>, "id"> & Pick<TripMessageRow, "trip_id" | "role" | "content">;
        Update: Partial<TripMessageRow>; // not allowed by the database grants, listed for completeness
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
