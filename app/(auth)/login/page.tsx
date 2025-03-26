"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { useState } from "react";

import { signIn } from "next-auth/react";
import { z } from "zod";

import { LastUsed, useLastUsed } from "@/components/hooks/useLastUsed";
import Google from "@/components/shared/icons/google";
import { Button } from "@/components/ui/button";

export default function Login() {
  const { next } = useParams as { next?: string };

  const [lastUsed, setLastUsed] = useLastUsed();
  const authMethods = ["google", "email", "linkedin", "passkey"] as const;
  type AuthMethod = (typeof authMethods)[number];
  const [clickedMethod, setClickedMethod] = useState<AuthMethod | undefined>(
    undefined,
  );
  const [email, setEmail] = useState<string>("");
  const [emailButtonText, setEmailButtonText] = useState<string>(
    "Continue with Email",
  );

  // const isValidEmail = email.length > 0 && validateEmail(email);
  const emailSchema = z
    .string()
    .trim()
    .toLowerCase()
    .min(3, { message: "Please enter a valid email." })
    .email({ message: "Please enter a valid email." });

  const emailValidation = emailSchema.safeParse(email);

  return (
    <div className="flex h-screen w-full flex-wrap">
      {/* Left part */}
      <div className="flex w-full justify-center bg-white">
        <div
          className="absolute inset-x-0 top-10 -z-10 flex transform-gpu justify-center overflow-hidden blur-3xl"
          aria-hidden="true"
        ></div>
        <div className="z-10 mx-5 mt-[calc(20vh)] h-fit w-full max-w-md overflow-hidden rounded-lg sm:mx-0">
          <div className="flex flex-col items-center justify-center space-y-3 px-4 py-6 pt-8 text-center sm:px-16">
            <Link href="/">
              <span className="text-balance text-2xl font-semibold text-gray-800">
                Welcome to Papermark
              </span>
            </Link>
            <h3 className="text-balance text-sm text-gray-800">
              Share documents. Not attachments.
            </h3>
          </div>
          <div className="flex flex-col space-y-2 px-4 sm:px-16">
            <div className="relative">
              <Button
                onClick={() => {
                  setClickedMethod("google");
                  setLastUsed("google");
                  signIn("google", {
                    ...(next && next.length > 0 ? { callbackUrl: next } : {}),
                  }).then((res) => {
                    if (res?.status) {
                      setClickedMethod(undefined);
                    }
                  });
                }}
                loading={clickedMethod === "google"}
                disabled={clickedMethod && clickedMethod !== "google"}
                className="flex w-full items-center justify-center space-x-2 border border-gray-200 bg-gray-100 font-normal text-gray-900 hover:bg-gray-200"
              >
                <Google className="h-5 w-5" />
                <span>Continue with Google</span>
                {clickedMethod !== "google" && lastUsed === "google" && (
                  <LastUsed />
                )}
              </Button>
            </div>
          </div>
          <p className="mt-10 w-full max-w-md px-4 text-xs text-muted-foreground sm:px-16">
            By clicking continue, you acknowledge that you have read and agree
            to Papermark&apos;s{" "}
            <a
              href="https://www.papermark.com/terms"
              target="_blank"
              className="underline"
            >
              Terms of Service
            </a>{" "}
            and{" "}
            <a
              href="https://www.papermark.com/privacy"
              target="_blank"
              className="underline"
            >
              Privacy Policy
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
