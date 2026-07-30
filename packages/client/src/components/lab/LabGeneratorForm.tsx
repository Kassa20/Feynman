import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { cn } from "@/lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

const labGeneratorSchema = z.object({
  topic: z
    .string()
    .trim()
    .min(1, "Topic is required")
    .max(500, "Topic cannot exceed 500 characters"),
  skillLevel: z.enum(["beginner", "intermediate", "advanced"], {
    message: "Select a skill level",
  }),
  environment: z.enum(["macos", "linux", "windows"]),
  starterCode: z.boolean(),
});

export type LabGeneratorFormData = z.infer<typeof labGeneratorSchema>;

const skillLevels: {
  value: LabGeneratorFormData["skillLevel"];
  label: string;
  selected: string;
}[] = [
  {
    value: "beginner",
    label: "Beginner",
    selected:
      "border-emerald-500 bg-emerald-100 text-emerald-900 dark:border-emerald-400 dark:bg-emerald-500/20 dark:text-emerald-200",
  },
  {
    value: "intermediate",
    label: "Intermediate",
    selected:
      "border-amber-500 bg-amber-100 text-amber-900 dark:border-amber-400 dark:bg-amber-500/20 dark:text-amber-200",
  },
  {
    value: "advanced",
    label: "Advanced",
    selected:
      "border-rose-500 bg-rose-100 text-rose-900 dark:border-rose-400 dark:bg-rose-500/20 dark:text-rose-200",
  },
];

export type Prefill = {
  values: LabGeneratorFormData;
  conversationId: string;
};

type Props = {
  prefill: Prefill | null;
  onSubmitted: () => void;
};

export const LabGeneratorForm = ({ prefill, onSubmitted }: Props) => {
  const navigate = useNavigate();
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset,
    formState: { errors, isValid },
  } = useForm<LabGeneratorFormData>({
    resolver: zodResolver(labGeneratorSchema),
    defaultValues: { topic: "", environment: "macos", starterCode: false },
  });

  const skillLevel = watch("skillLevel");

  // The inputs are uncontrolled, so the only way to fill them from outside is to
  // hand react-hook-form the values. A fresh object arrives on every Regenerate
  // click, which is what lets a second click discard edits from an abandoned one.
  useEffect(() => {
    if (prefill) reset(prefill.values);
  }, [prefill, reset]);

  const onSubmit = (data: LabGeneratorFormData) => {
    // Reusing the id is what keeps a regeneration in the same window; a fresh
    // lab mints a new one.
    const conversationId = prefill?.conversationId ?? crypto.randomUUID();
    const regenerate = Boolean(prefill);
    reset();
    // Drop the prefill now it is spent, or the next submit would target this
    // same conversation again.
    onSubmitted();
    navigate(`/chat/${conversationId}`, {
      // runId forces a fresh ChatBot even though the URL is unchanged.
      state: { labData: data, regenerate, runId: crypto.randomUUID() },
    });
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex h-full w-full max-w-sm flex-col"
    >
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto">
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <span className="size-2 rounded-sm bg-sky-500" aria-hidden />
            Topic
          </div>
          <Textarea
            {...register("topic")}
            placeholder="e.g. Set up a local Kubernetes cluster with a sample microservice"
            className="min-h-24 resize-y"
          />
          {errors.topic && (
            <p className="mt-1 text-sm text-destructive">
              {errors.topic.message}
            </p>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <span className="size-2 rounded-sm bg-amber-400" aria-hidden />
            Your skill level
          </div>
          <input type="hidden" {...register("skillLevel")} />
          <div className="flex gap-2">
            {skillLevels.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() =>
                  setValue("skillLevel", option.value, {
                    shouldValidate: true,
                  })
                }
                className={cn(
                  "flex-1 rounded-xl border px-2 py-2.5 text-center text-sm font-semibold",
                  skillLevel === option.value
                    ? option.selected
                    : "border-border bg-background hover:bg-muted",
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          {errors.skillLevel && (
            <p className="mt-1 text-sm text-destructive">
              {errors.skillLevel.message}
            </p>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
            <span className="size-2 rounded-sm bg-emerald-500" aria-hidden />
            Target environment
          </div>
          <select
            {...register("environment")}
            className="w-full rounded-xl border border-border bg-background px-3.5 py-2.5 text-sm outline-none"
          >
            <option value="macos">macOS</option>
            <option value="linux">Linux</option>
            <option value="windows">Windows (WSL2)</option>
          </select>
        </div>

        <div>
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              {...register("starterCode")}
              className="mt-0.5 size-4 shrink-0 accent-primary"
            />
            <span>
              <span className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                <span className="size-2 rounded-sm bg-orange-500" aria-hidden />
                Generate starter code
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground/70">
                Downloadable project scaffold with dependencies listed
              </span>
            </span>
          </label>
        </div>
      </div>

      <div className="flex shrink-0 flex-col gap-2 pt-4">
        <Button
          type="submit"
          disabled={!isValid}
          className={cn(
            "w-56 self-center rounded-xl px-6 py-6",
            prefill && "bg-[#E50914] text-white hover:bg-[#c11119]",
          )}
        >{prefill ? "Regenerate" : "Generate"}</Button>
      </div>
    </form>
  );
};
