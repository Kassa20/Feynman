import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";
import { api } from "@/lib/api";
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

type LabGeneratorFormData = z.infer<typeof labGeneratorSchema>;

const skillLevels: {
  value: LabGeneratorFormData["skillLevel"];
  label: string;
}[] = [
  { value: "beginner", label: "Beginner" },
  { value: "intermediate", label: "Intermediate" },
  { value: "advanced", label: "Advanced" },
];

type LabResponse = {
  id: string;
  content: unknown;
};

export const LabGeneratorForm = () => {
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
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skillLevel = watch("skillLevel");

  const onSubmit = async ({
    topic,
    skillLevel,
    environment,
    starterCode,
  }: LabGeneratorFormData) => {
    setGenerating(true);
    setError(null);

    const conversationId = crypto.randomUUID();

    try {
      await api.post<LabResponse>("/api/labs/generate", {
        topic,
        skillLevel,
        environment,
        starterCode,
        conversationId,
      });
      reset();
      navigate(`/chat/${conversationId}`);
    } catch {
      setError("Something went wrong generating your lab. Please try again.");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="flex h-full w-full max-w-sm flex-col"
    >
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto">
        <div>
          <div className="mb-2 text-sm font-semibold text-muted-foreground">
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
          <div className="mb-2 text-sm font-semibold text-muted-foreground">
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
                    ? "border-primary bg-primary text-primary-foreground"
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
          <div className="mb-2 text-sm font-semibold text-muted-foreground">
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
              <span className="text-sm font-semibold text-muted-foreground">
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
        {error && <p className="text-sm text-destructive">{error}</p>}

        <Button
          type="submit"
          disabled={!isValid || generating}
          className="w-56 self-center rounded-xl px-6 py-6"
        >
          {generating ? "Writing your lab…" : "Generate"}
        </Button>
      </div>
    </form>
  );
};
