import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useAuth } from "@/lib/auth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Radio, Loader2, KeyRound } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/reset-password")({
  component: ResetPasswordPage,
  head: () => ({ meta: [{ title: "Reset password — Aurixa Systems Mission Control" }] }),
});

const schema = z
  .object({
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirm: z.string().min(1, "Confirm your password"),
  })
  .refine((d) => d.password === d.confirm, {
    message: "Passwords don't match",
    path: ["confirm"],
  });
type Values = z.infer<typeof schema>;

function ResetPasswordPage() {
  // Supabase parses the recovery token from the URL and sets a session on load;
  // once it resolves, `session` is populated and we can accept a new password.
  const { session, loading } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { password: "", confirm: "" },
  });

  const onSubmit = async (values: Values) => {
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: values.password });
    setBusy(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Password updated — you're signed in");
    void nav({ to: "/dashboard" });
  };

  return (
    <div className="grid-bg flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md space-y-6">
        <Card>
          <CardHeader className="items-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center bg-primary/15 ring-1 ring-primary/40">
              <Radio className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="font-mono tracking-wide">SET A NEW PASSWORD</CardTitle>
            <CardDescription>Choose a new password for your operator account.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex h-32 items-center justify-center text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
              </div>
            ) : !session ? (
              <div className="space-y-4 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 ring-1 ring-destructive/30">
                  <KeyRound className="h-6 w-6 text-destructive" />
                </div>
                <p className="text-sm text-muted-foreground">
                  This reset link is invalid or has expired. Request a new one from the sign-in
                  screen.
                </p>
                <Button asChild variant="outline">
                  <Link to="/auth">Back to sign in</Link>
                </Button>
              </div>
            ) : (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                  <FormField
                    control={form.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>New password</FormLabel>
                        <FormControl>
                          <Input type="password" autoComplete="new-password" autoFocus {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="confirm"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Confirm password</FormLabel>
                        <FormControl>
                          <Input type="password" autoComplete="new-password" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="w-full" disabled={busy}>
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {busy ? "Updating…" : "Update password"}
                  </Button>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
