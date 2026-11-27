-- Tasks saved without a day get the day and time-of-day words ("förmiddag") from the call's own saved interpretation.
CREATE OR REPLACE FUNCTION public.samtal_task_due_from_call() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE s jsonb;
BEGIN
  IF NEW.due_date IS NULL AND NEW.due_at IS NULL THEN
    SELECT st INTO s FROM samtal_calls c, jsonb_array_elements(coalesce(c.extraction->'interpretation'->'next_steps','[]'::jsonb)) st
      WHERE c.id=NEW.call_id AND c.company_id=NEW.company_id AND st->>'kind'=NEW.kind AND st->>'title'=NEW.title LIMIT 1;
    IF s IS NOT NULL AND (s->>'date') ~ '^\d{4}-\d{2}-\d{2}$' THEN
      NEW.due_date:=(s->>'date')::date;
      NEW.due_hint:=nullif(left(coalesce(s->>'time_hint',''),40),'');
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.samtal_task_due_from_call() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER samtal_task_due_from_call BEFORE INSERT ON public.samtal_tasks FOR EACH ROW EXECUTE FUNCTION public.samtal_task_due_from_call();