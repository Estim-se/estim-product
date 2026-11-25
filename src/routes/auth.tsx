import { createFileRoute } from '@tanstack/react-router';
import { AuthPage } from '@/components/estim/auth-page';
import { Outlet, useLocation } from '@tanstack/react-router';
export const Route=createFileRoute('/auth')({head:()=>({meta:[{title:'estim · Logga in'},{name:'description',content:'Logga in i estim med lösenord eller en engångslänk.'},{property:'og:title',content:'estim · Logga in'},{property:'og:description',content:'Logga in i estim med lösenord eller en engångslänk.'},{property:'og:type',content:'website'},{name:'twitter:card',content:'summary_large_image'}]}),component:AuthLayout});
// /auth shows the sign-in page; its child routes (such as /auth/callback) render alone.
function AuthLayout(){return useLocation().pathname==='/auth'?<><AuthPage/><Outlet/></>:<Outlet/>;}