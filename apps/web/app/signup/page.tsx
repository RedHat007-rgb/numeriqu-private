"use client";

import React, { useState } from 'react';
import '../globals.css';
import Link from 'next/link';

export default function SignupPage() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    company: '',
    password: ''
  });
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    // Simulate premium registration
    setTimeout(() => {
      window.location.href = '/';
    }, 1500);
  };

  return (
    <div className="auth-container animate-fade" style={{ background: '#050505' }}>
      {/* Dynamic Background Elements */}
      <div className="premium-orb-1"></div>
      <div className="premium-orb-2"></div>
      
      <div className="auth-card glass-panel animate-slide-up" style={{ maxWidth: '540px', padding: '60px' }}>
        <div className="logo-container" style={{ justifyContent: 'center', marginBottom: '40px' }}>
          <div className="logo-icon">N</div>
          <div className="logo-text text-shiny">NUMERIQU</div>
        </div>

        <div className="auth-header" style={{ textAlign: 'center', marginBottom: '48px' }}>
          <h1 className="text-gradient" style={{ fontSize: '2.2rem', fontWeight: 800, marginBottom: '12px' }}>
            Elevate your Finance
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: '1.05rem', lineHeight: 1.6 }}>
            Join the elite circle of data-driven CFOs. <br/>
            Experience the future of financial operations.
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="dashboard-grid" style={{ gap: '20px', marginBottom: '32px' }}>
            <div className="col-span-6">
              <label className="label">FULL NAME</label>
              <input 
                type="text" 
                className="input-modern" 
                placeholder="John Doe" 
                required 
                onChange={(e) => setFormData({...formData, name: e.target.value})}
              />
            </div>
            <div className="col-span-6">
              <label className="label">COMPANY</label>
              <input 
                type="text" 
                className="input-modern" 
                placeholder="Numeriqu Corp" 
                required 
                onChange={(e) => setFormData({...formData, company: e.target.value})}
              />
            </div>
            <div className="col-span-12">
              <label className="label">WORK EMAIL</label>
              <input 
                type="email" 
                className="input-modern" 
                placeholder="john@numeriqu.io" 
                required 
                onChange={(e) => setFormData({...formData, email: e.target.value})}
              />
            </div>
            <div className="col-span-12">
              <label className="label">SECURE PASSWORD</label>
              <input 
                type="password" 
                className="input-modern" 
                placeholder="••••••••" 
                required 
                onChange={(e) => setFormData({...formData, password: e.target.value})}
              />
            </div>
          </div>

          <button type="submit" className="btn-glow" disabled={isLoading} style={{ height: '58px', fontSize: '1rem' }}>
            {isLoading ? "Provisioning OS..." : "Create Account"}
          </button>
        </form>

        <div style={{ marginTop: '40px', textAlign: 'center', color: 'var(--muted)', fontSize: '0.9rem' }}>
          By joining, you agree to our <span className="text-shiny" style={{ cursor: 'pointer' }}>Terms of Sovereignty</span>
        </div>
        
        <div style={{ marginTop: '24px', textAlign: 'center', fontSize: '0.9rem' }}>
          Already using Numeriqu? <Link href="/" className="text-shiny">Sign In</Link>
        </div>
      </div>

      <style jsx>{`
        .premium-orb-1 {
          position: absolute;
          top: -10%;
          right: -10%;
          width: 600px;
          height: 600px;
          background: radial-gradient(circle, rgba(0, 245, 212, 0.15) 0%, transparent 70%);
          filter: blur(100px);
          z-index: 0;
          animation: orb-flow 20s infinite linear;
        }
        .premium-orb-2 {
          position: absolute;
          bottom: -15%;
          left: -5%;
          width: 500px;
          height: 500px;
          background: radial-gradient(circle, rgba(155, 93, 229, 0.1) 0%, transparent 70%);
          filter: blur(80px);
          z-index: 0;
          animation: orb-flow 25s infinite linear reverse;
        }
        @keyframes orb-flow {
          0% { transform: rotate(0deg) translate(0, 0); }
          50% { transform: rotate(180deg) translate(50px, 100px); }
          100% { transform: rotate(360deg) translate(0, 0); }
        }
      `}</style>
    </div>
  );
}
