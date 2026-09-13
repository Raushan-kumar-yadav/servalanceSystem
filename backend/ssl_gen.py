"""
ssl_gen.py — Auto-generate a self-signed SSL certificate.

Stored at the project root as surveillance_cert.pem / surveillance_key.pem.
Regenerated if the LAN IP has changed (so mobile SANs stay valid).
"""
from __future__ import annotations

import datetime
import ipaddress
import json
import socket
from pathlib import Path

_ROOT     = Path(__file__).parent.parent
CERT_FILE = _ROOT / "surveillance_cert.pem"
KEY_FILE  = _ROOT / "surveillance_key.pem"
META_FILE = _ROOT / "surveillance_cert_meta.json"   # stores IP the cert was made for


def lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _cert_is_valid_for(ip: str) -> bool:
    if not (CERT_FILE.exists() and KEY_FILE.exists() and META_FILE.exists()):
        return False
    try:
        meta = json.loads(META_FILE.read_text())
        return meta.get("lan_ip") == ip
    except Exception:
        return False


def generate_cert() -> tuple[str, str] | None:
    """
    Return (cert_path, key_path) for a self-signed cert valid for
    localhost, 127.0.0.1, and the current LAN IP.
    Returns None if cryptography package is unavailable.
    """
    current_ip = lan_ip()

    if _cert_is_valid_for(current_ip):
        return str(CERT_FILE), str(KEY_FILE)

    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.x509.oid import NameOID
    except ImportError:
        print("[ssl] 'cryptography' package not found — falling back to HTTP", flush=True)
        return None

    print(f"[ssl] Generating self-signed cert (LAN IP: {current_ip}) …", flush=True)

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "SurvAIllance Local"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "ServelanceSystem"),
    ])

    san_names: list = [x509.DNSName("localhost")]
    san_ips: list   = [x509.IPAddress(ipaddress.IPv4Address("127.0.0.1"))]
    if current_ip not in ("127.0.0.1", ""):
        san_ips.append(x509.IPAddress(ipaddress.IPv4Address(current_ip)))

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.utcnow())
        .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=3650))
        .add_extension(
            x509.SubjectAlternativeName(san_names + san_ips),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    CERT_FILE.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    KEY_FILE.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    META_FILE.write_text(json.dumps({"lan_ip": current_ip}))

    print(f"[ssl] Cert written → {CERT_FILE.name}", flush=True)
    return str(CERT_FILE), str(KEY_FILE)
