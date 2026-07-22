import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";
import { AuthField, AuthLayout, authInputClass } from "@/components/AuthLayout";
import { supabase } from "@/lib/supabase";

const loginSchema = z.object({
  email: z.string().min(1, "Email is required").email("Enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

type LoginValues = z.infer<typeof loginSchema>;

export function LoginPage() {
  const navigate = useNavigate();
  const [formError, setFormError] = useState("");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({ resolver: zodResolver(loginSchema) });

  const onSubmit = async (values: LoginValues) => {
    setFormError("");
    const { error } = await supabase.auth.signInWithPassword(values);
    if (error) {
      setFormError(error.message);
      return;
    }
    navigate("/", { replace: true });
  };

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Log in to pick up where you left off."
      footer={
        <>
          Don't have an account?{" "}
          <Link
            to="/register"
            className="font-semibold text-[#3d2622] hover:text-[#00937a]"
          >
            Sign up
          </Link>
        </>
      }
    >
      <form
        onSubmit={handleSubmit(onSubmit)}
        className="flex flex-col gap-4"
        noValidate
      >
        <AuthField label="Email" error={errors.email?.message}>
          <input
            type="email"
            placeholder="you@example.com"
            className={authInputClass}
            {...register("email")}
          />
        </AuthField>

        <AuthField label="Password" error={errors.password?.message}>
          <input
            type="password"
            placeholder="••••••••"
            className={authInputClass}
            {...register("password")}
          />
        </AuthField>

        {formError && <p className="text-sm text-[#d1352b]">{formError}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-2 rounded-[14px] bg-[#00b894] py-3.5 text-[15px] font-bold text-white transition-colors hover:bg-[#00937a] disabled:opacity-60"
        >
          {isSubmitting ? "Logging in…" : "Log in"}
        </button>
      </form>
    </AuthLayout>
  );
}
