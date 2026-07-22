import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";
import { AuthField, AuthLayout, authInputClass } from "@/components/AuthLayout";
import { supabase } from "@/lib/supabase";

const registerSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    email: z.string().min(1, "Email is required").email("Enter a valid email"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirmPassword: z.string().min(1, "Please confirm your password"),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

type RegisterValues = z.infer<typeof registerSchema>;

export function RegisterPage() {
  const navigate = useNavigate();
  const [formError, setFormError] = useState("");
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<RegisterValues>({ resolver: zodResolver(registerSchema) });

  const onSubmit = async (values: RegisterValues) => {
    setFormError("");
    const { error } = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      options: { data: { name: values.name } },
    });
    if (error) {
      setFormError(error.message);
      return;
    }
    navigate("/", { replace: true });
  };

  return (
    <AuthLayout
      title="Create your account"
      subtitle="Sign up to start generating labs."
      footer={
        <>
          Already have an account?{" "}
          <Link
            to="/login"
            className="font-semibold text-[#3d2622] hover:text-[#00937a]"
          >
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate>
        <AuthField label="Name" error={errors.name?.message}>
          <input
            type="text"
            placeholder="Ada Lovelace"
            className={authInputClass}
            {...register("name")}
          />
        </AuthField>

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

        <AuthField
          label="Confirm password"
          error={errors.confirmPassword?.message}
        >
          <input
            type="password"
            placeholder="••••••••"
            className={authInputClass}
            {...register("confirmPassword")}
          />
        </AuthField>

        {formError && <p className="text-sm text-[#d1352b]">{formError}</p>}

        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-2 rounded-[14px] bg-[#00b894] py-3.5 text-[15px] font-bold text-white transition-colors hover:bg-[#00937a] disabled:opacity-60"
        >
          {isSubmitting ? "Creating account…" : "Create account"}
        </button>
      </form>
    </AuthLayout>
  );
}
