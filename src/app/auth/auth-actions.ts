'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { prisma } from '@/lib/prisma'
import { hashPassword, comparePasswords } from '@/lib/auth-utils'

export async function login(formData: FormData) {
  const email = formData.get('email') as string
  const password = formData.get('password') as string

  if (!email || !password) {
    redirect('/login?error=' + encodeURIComponent('Email and password are required'))
  }

  let success = false
  let errorMessage = ''
  const targetUrl = '/library'

  try {
    const user = await prisma.user.findUnique({
      where: { email }
    })

    const supabase = await createClient()

    if (!user) {
      const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
      
      if (signInError) {
        errorMessage = signInError.message === 'Invalid login credentials' 
          ? 'Invalid email or password' 
          : signInError.message
      } else if (signInData.user) {
        const password_hash = await hashPassword(password)
        await prisma.user.upsert({
          where: { id: signInData.user.id },
          update: { email },
          create: {
            id: signInData.user.id,
            email,
            username: signInData.user.user_metadata?.username || email.split('@')[0],
            password_hash,
            xp: 0,
            level: 1,
            subscription_tier: 'free',
          }
        })
        success = true
      }
    } else {
      const isPasswordValid = await comparePasswords(password, user.password_hash)
      
      if (!isPasswordValid) {
        const { data: signInData, error: fallbackError } = await supabase.auth.signInWithPassword({ email, password })
        if (!fallbackError && signInData.user) {
          const password_hash = await hashPassword(password)
          await prisma.user.update({
            where: { id: user.id },
            data: { password_hash }
          })
          success = true
        } else {
          errorMessage = 'Invalid email or password'
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })

        if (error) {
          errorMessage = error.message
          if (error.message.includes('Email not confirmed')) {
            errorMessage = 'Please confirm your email before logging in.'
          }
        } else {
          success = true
        }
      }
    }
  } catch (err: any) {
    if (err.digest?.includes('NEXT_REDIRECT') || err.message === 'NEXT_REDIRECT') {
      throw err
    }
    errorMessage = 'An unexpected server error occurred. Please try again later.'
  }

  if (success) {
    revalidatePath('/', 'layout')
    redirect(targetUrl)
  } else {
    redirect('/login?error=' + encodeURIComponent(errorMessage || 'Login failed'))
  }
}

export async function signup(formData: FormData) {
  const email = formData.get('email') as string
  const password = formData.get('password') as string
  const username = formData.get('username') as string

  if (!email || !password || !username) {
    redirect('/register?error=' + encodeURIComponent('All fields are required'))
  }

  let success = false
  let errorMessage = ''
  let needsConfirmation = false

  try {
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email },
          { username }
        ]
      }
    })

    if (existingUser) {
      errorMessage = 'User already exists with this email or username'
    } else {
      const supabase = await createClient()
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { username }
        }
      })

      if (authError) {
        errorMessage = authError.message
      } else if (!authData.user) {
        errorMessage = 'Failed to create account'
      } else {
        const isConfirmed = !!authData.user.email_confirmed_at
        const password_hash = await hashPassword(password)
        
        await prisma.user.upsert({
          where: { id: authData.user.id },
          update: {
            email,
            username,
            password_hash
          },
          create: {
            id: authData.user.id,
            email,
            username,
            password_hash,
            xp: 0,
            level: 1,
            streak_days: 0,
            subscription_tier: 'free',
            notification_settings: { email: true, push: false },
            privacy_settings: { library_public: true, activity_public: true },
          }
        })
        
        if (isConfirmed) {
          success = true
        } else {
          needsConfirmation = true
        }
      }
    }
  } catch (err: any) {
    if (err.digest?.includes('NEXT_REDIRECT') || err.message === 'NEXT_REDIRECT') {
      throw err
    }
    errorMessage = 'An unexpected error occurred during registration.'
  }

  if (success) {
    revalidatePath('/', 'layout')
    redirect('/library')
  } else if (needsConfirmation) {
    redirect('/login?message=' + encodeURIComponent('Please check your email to confirm your account before logging in.'))
  } else {
    redirect('/register?error=' + encodeURIComponent(errorMessage || 'Registration failed'))
  }
}

export async function logout() {
  try {
    const supabase = await createClient()
    await supabase.auth.signOut()
  } catch (err: any) {
    if (err.digest?.includes('NEXT_REDIRECT') || err.message === 'NEXT_REDIRECT') {
      throw err
    }
  } finally {
    revalidatePath('/', 'layout')
    redirect('/')
  }
}
