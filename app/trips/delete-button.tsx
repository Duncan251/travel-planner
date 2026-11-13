"use client";

// Asks before deleting, because a deleted trip and its conversation can't be recovered.
export default function DeleteTripButton({ title }: { title: string }) {
  return (
    <button
      type="submit"
      className="link-button danger"
      onClick={(e) => {
        if (!confirm(`Delete "${title}" and its whole conversation? This can't be undone.`)) e.preventDefault();
      }}
    >
      Delete
    </button>
  );
}
