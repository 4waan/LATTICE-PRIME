import json, urllib.request
# EIP-152 blake2f input: rounds(4) h(64) m(128) t(16) f(1) = 213 bytes.
# Gas cost == rounds, exactly 1 gas per round. So `rounds` is a 1-gas-resolution
# dial on total call cost, using only 213 bytes of calldata.
def blake2f(rounds):
    return "%08x"%rounds + "00"*64 + "00"*128 + "00"*16 + "00"
def rpc(url,m,params):
    req=urllib.request.Request(url,method="POST",
      data=json.dumps({"jsonrpc":"2.0","id":1,"method":m,"params":params}).encode(),
      headers={"Content-Type":"application/json","User-Agent":"curl/8.4.0"})
    try: return json.loads(urllib.request.urlopen(req,timeout=90).read())
    except urllib.error.HTTPError as e:
        try: return json.loads(e.read())
        except Exception: return {"error":{"message":"HTTP %s"%e.code}}
    except Exception as e: return {"error":{"message":str(e)}}
def cdgas(h): return sum(4 if b==0 else 16 for b in bytes.fromhex(h))
def ok(url,rounds):
    r=rpc(url,"eth_call",[{"to":"0x0000000000000000000000000000000000000009",
                           "data":"0x"+blake2f(rounds)},"latest"])
    return "result" in r and r["result"]!="0x"

for label,url in [("Hedera testnet","https://testnet.hashio.io/api"),
                  ("Hedera MAINNET","https://mainnet.hashio.io/api")]:
    if not ok(url,1):
        print("%-16s blake2f baseline failed; skipping"%label); continue
    lo,hi=1,60_000_000
    if ok(url,hi):
        print("%-16s no ceiling below %d"%(label,hi)); continue
    while lo<hi:
        mid=(lo+hi+1)//2
        if ok(url,mid): lo=mid
        else: hi=mid-1
    overhead = 21000 + cdgas(blake2f(lo))
    print("%-16s max rounds = %-10d  overhead(intrinsic+calldata) = %d"%(label,lo,overhead))
    print("%-16s   EXACT CALL GAS CEILING = %d"%("",lo+overhead))
