import { NextResponse, type NextRequest } from 'next/server'

import { supabaseServer } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const supabase = await supabaseServer()
  await supabase.auth.signOut()
  return NextResponse.redirect(`${request.nextUrl.origin}/login`)
}
