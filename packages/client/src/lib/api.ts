import axios from "axios";
import { supabase } from "./supabase";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL,
});

api.interceptors.request.use(async (config) => {
  Object.assign(config.headers, await authHeaders())
  return config;
});

export async function authHeaders(): Promise<Record<string, string>> {
  const {
    data: { session }, 
  } = await supabase.auth.getSession();

  return session ? { Authorization: `Bearer ${session.access_token}` } : {};
}
