// The travel preferences a user can save, matching the columns of the profiles table
// (supabase/migrations/20261112120000_create_profiles.sql). Used by the preferences
// form, the code that saves it, and the chat's system prompt.

import type { PreferenceColumn, ProfileRow } from "./supabase/database.types";

export type PreferenceField = {
  column: PreferenceColumn;
  label: string;
  hint?: string;
  options?: { value: string; label: string }[]; // a fixed choice instead of free text
};

export const PREFERENCE_FIELDS: PreferenceField[] = [
  { column: "food_likes", label: "Food you love", hint: "e.g. seafood, street food, wine bars" },
  { column: "food_dislikes", label: "Food you'd rather avoid", hint: "e.g. very spicy food, offal" },
  { column: "dietary_needs", label: "Dietary needs", hint: "e.g. vegetarian, gluten-free, nut allergy" },
  {
    column: "tour_style",
    label: "Guided or self-guided",
    options: [
      { value: "guided", label: "Guided tours" },
      { value: "self-guided", label: "Self-guided" },
      { value: "mix", label: "A mix of both" },
    ],
  },
  {
    column: "pace",
    label: "Pace",
    options: [
      { value: "relaxed", label: "Relaxed" },
      { value: "moderate", label: "Moderate" },
      { value: "full", label: "Full days" },
    ],
  },
  { column: "interests", label: "Interests", hint: "e.g. history, architecture, hiking, markets" },
  { column: "things_to_avoid", label: "Things to avoid", hint: "e.g. big crowds, early starts, long drives" },
  { column: "preferred_airlines", label: "Preferred airlines" },
  { column: "preferred_hotels", label: "Preferred hotels or chains" },
  { column: "preferred_tour_companies", label: "Preferred tour companies" },
  { column: "accessibility_needs", label: "Accessibility needs", hint: "e.g. step-free access, limited walking" },
];

export const MAX_PREFERENCE_LENGTH = 500;

export type Profile = Partial<ProfileRow>;

// The saved preferences as lines for the system prompt, or [] if none are filled in.
export function describePreferences(profile: Profile | null): string[] {
  if (!profile) return [];
  return PREFERENCE_FIELDS.flatMap((field) => {
    const value = profile[field.column];
    if (!value) return [];
    const shown = field.options?.find((o) => o.value === value)?.label ?? value;
    return [`- ${field.label}: ${shown}`];
  });
}
