import { Password } from '@convex-dev/auth/providers/Password'
import { convexAuth } from '@convex-dev/auth/server'
import { ConvexError } from 'convex/values'

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password({
      profile(params) {
        const email = String(params.email ?? '').trim().toLowerCase()
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ConvexError('Enter a valid email address')
        const name = String(params.name ?? '').trim()
        // The name is only sent when signing up; sign-in must not overwrite it.
        const profile: { email: string; name?: string } = { email }
        if (name) profile.name = name.slice(0, 80)
        return profile
      },
      validatePasswordRequirements(password) {
        if (password.length < 8) throw new ConvexError('Password must be at least 8 characters')
      },
    }),
  ],
})
