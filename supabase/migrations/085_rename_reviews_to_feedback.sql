-- Product decision: this is "feedback", not "reviews" — self-published
-- reviews read as marketing and won't be trusted. Rename the table,
-- column, index, and policies from migrations 083/084 to match.
-- Data is preserved; RLS policies stay attached through the renames.

ALTER TABLE user_reviews RENAME TO user_feedback;
ALTER TABLE user_feedback RENAME COLUMN review_text TO feedback_text;

ALTER INDEX user_reviews_created_at_idx RENAME TO user_feedback_created_at_idx;

ALTER POLICY "user_reviews_self_select" ON user_feedback RENAME TO "user_feedback_self_select";
ALTER POLICY "user_reviews_self_insert" ON user_feedback RENAME TO "user_feedback_self_insert";
ALTER POLICY "user_reviews_self_update" ON user_feedback RENAME TO "user_feedback_self_update";
