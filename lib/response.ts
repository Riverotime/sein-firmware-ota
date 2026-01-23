import { NextResponse } from 'next/server'

export function successResponse(data: unknown) {
  return NextResponse.json({
    success: true,
    data
  })
}

export function errorResponse(
  code: string,
  message: string,
  status: number = 400
) {
  return NextResponse.json(
    {
      success: false,
      error: { code, message }
    },
    { status }
  )
}
