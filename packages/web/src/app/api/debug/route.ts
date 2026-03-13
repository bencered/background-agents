import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    hasControlPlaneUrl: !!process.env.CONTROL_PLANE_URL,
    controlPlaneUrl: process.env.CONTROL_PLANE_URL?.substring(0, 30),
    hasInternalSecret: !!process.env.INTERNAL_CALLBACK_SECRET,
    internalSecretLength: process.env.INTERNAL_CALLBACK_SECRET?.length || 0,
    hasGithubClientSecret: !!process.env.GITHUB_CLIENT_SECRET,
    hasNextAuthSecret: !!process.env.NEXTAUTH_SECRET,
  });
}
